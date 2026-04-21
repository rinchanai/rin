import fs from "node:fs";
import path from "node:path";

import prettyMilliseconds from "pretty-ms";

import { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";
import { RpcInteractiveSession } from "../rin-tui/runtime.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import {
  normalizeSessionRef,
  resolveStoredSessionFile,
  toStoredSessionFile,
} from "../session/ref.js";
import {
  chatStatePath,
  isPrivateChat,
  parseChatKey,
  readJsonFile,
  writeJsonFile,
} from "./support.js";
import {
  ChatState,
  SavedAttachment,
  extractTextFromContent,
  markProcessedChatMessage,
  safeString,
} from "./chat-helpers.js";
import {
  clearWorkingReaction as clearWorkingReactionTick,
  restorePromptParts,
  rotateWorkingReaction,
  sendOutboxPayload,
  sendTyping,
} from "./transport.js";
import { isTransientChatRuntimeError } from "./runtime-errors.js";

const WORKING_REACTION_FRAME_INTERVAL_MS = 30_000;
const INTERIM_PREFIX = "··· ";

type ChatTurnMeta = {
  incomingMessageId?: string;
  replyToMessageId?: string;
  workingNoticeSent?: boolean;
  startedAt: number;
};

function commandNameFromCommandLine(commandLine: string) {
  const trimmed = safeString(commandLine).trim();
  if (!trimmed.startsWith("/")) return "";
  const commandPart = trimmed.slice(1).trim();
  if (!commandPart) return "";
  return safeString(commandPart.split(/\s+/, 1)[0]).trim();
}

function isAgentAlreadyProcessingError(error: unknown) {
  return safeString((error as any)?.message || error).includes(
    "Agent is already processing.",
  );
}

function summarizePromptText(text: string, limit = 80) {
  const value = safeString(text).replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export class ChatController {
  app: any;
  chatKey: string;
  dataDir: string;
  agentDir: string;
  statePath: string;
  state: ChatState;
  client: RinDaemonFrontendClient | null = null;
  session: RpcInteractiveSession | null = null;
  turnQueue: Promise<void> = Promise.resolve();
  liveTurn: {
    requestTag?: string;
    promise: Promise<any>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  } | null = null;
  latestAssistantText = "";
  pendingCompletedAssistantText = "";
  deliveredInterimTexts = new Set<string>();
  interimDeliveryQueue: Promise<void> = Promise.resolve();
  logger: any;
  h: any;
  deliveryEnabled: boolean;
  affectChatBinding: boolean;
  workingReactionEmoji = "";
  workingReactionTick = 0;
  lastWorkingReactionAt = 0;
  frontendPhase: "idle" | "connecting" | "starting" | "sending" | "working" =
    "idle";
  currentTurn: ChatTurnMeta | null = null;

  constructor(
    app: any,
    dataDir: string,
    chatKey: string,
    deps: {
      logger: any;
      h: any;
      deliveryEnabled?: boolean;
      affectChatBinding?: boolean;
      statePath?: string;
    },
  ) {
    this.app = app;
    this.chatKey = chatKey;
    this.dataDir = dataDir;
    this.agentDir = path.resolve(dataDir, "..");
    this.deliveryEnabled = deps.deliveryEnabled !== false;
    this.affectChatBinding = deps.affectChatBinding !== false;
    this.statePath = deps.statePath || chatStatePath(dataDir, chatKey);
    this.state = readJsonFile<ChatState>(this.statePath, { chatKey });
    this.logger = deps.logger;
    this.h = deps.h;
    if (!this.state.chatKey) this.state.chatKey = chatKey;
    delete this.state.processing;
    delete this.state.pendingDelivery;
  }

  async connect(options: { restoreSession?: boolean } = {}) {
    if (this.session && this.client) return;
    const client = new RinDaemonFrontendClient();
    const session = new RpcInteractiveSession(client);
    await session.connect();
    this.client = client;
    this.session = session;

    session.subscribe((event: any) => {
      void this.handleSessionEvent(event).catch(() => {});
    });

    if (options.restoreSession === false) return;
    const wantedSessionFile = this.getRecoverableSessionFile();
    if (wantedSessionFile) {
      await session.switchSession(wantedSessionFile);
      this.updateStoredSessionFile(wantedSessionFile);
      this.saveState();
    }
  }

  dispose() {
    void this.clearWorkingReaction().catch(() => {});
    this.failLiveTurn(new Error("chat_controller_disposed"));
    this.currentTurn = null;
    this.frontendPhase = "idle";
    void this.session?.disconnect().catch(() => {});
    this.client = null;
    this.session = null;
  }

  private saveState() {
    const nextState: ChatState = { chatKey: this.chatKey };
    const storedSessionFile = toStoredSessionFile(
      this.agentDir,
      this.state.piSessionFile,
    );
    if (storedSessionFile) nextState.piSessionFile = storedSessionFile;
    writeJsonFile(this.statePath, nextState);
  }

  async clearProcessingState() {
    this.currentTurn = null;
    await this.clearWorkingReaction().catch(() => {});
    delete this.state.processing;
    delete this.state.pendingDelivery;
    this.saveState();
  }

  private createTurnRequestTag() {
    return `chat_turn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  private currentIncomingMessageId() {
    return safeString(
      this.currentTurn?.incomingMessageId || this.state.processing?.incomingMessageId || "",
    ).trim();
  }

  private currentReplyToMessageId() {
    return safeString(
      this.currentTurn?.replyToMessageId ||
        this.currentTurn?.incomingMessageId ||
        this.state.processing?.replyToMessageId ||
        this.state.processing?.incomingMessageId ||
        "",
    ).trim();
  }

  claimsInboundMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return false;
    return this.currentIncomingMessageId() === nextMessageId;
  }

  hasActiveTurn() {
    return (
      this.frontendPhase === "sending" ||
      this.frontendPhase === "working" ||
      Boolean(this.liveTurn) ||
      Boolean(this.state.processing)
    );
  }

  private setCurrentTurn(input: {
    text?: string;
    attachments?: SavedAttachment[];
    incomingMessageId?: string;
    replyToMessageId?: string;
  }) {
    const nextIncomingMessageId =
      safeString(input.incomingMessageId || "").trim() || undefined;
    const nextReplyToMessageId =
      safeString(input.replyToMessageId || "").trim() || undefined;
    const previousIncomingMessageId = this.currentIncomingMessageId();
    if (
      previousIncomingMessageId &&
      nextIncomingMessageId &&
      previousIncomingMessageId !== nextIncomingMessageId
    ) {
      void this.clearWorkingReaction().catch(() => {});
    }
    this.currentTurn = {
      startedAt: Date.now(),
      incomingMessageId: nextIncomingMessageId,
      replyToMessageId: nextReplyToMessageId,
      workingNoticeSent: false,
    };
    this.state.processing = {
      text: safeString(input.text || "").trim(),
      attachments: Array.isArray(input.attachments) ? [...input.attachments] : [],
      startedAt: this.currentTurn.startedAt,
      incomingMessageId: nextIncomingMessageId,
      replyToMessageId: nextReplyToMessageId,
      workingNoticeSent: false,
    };
    this.saveState();
  }

  private clearCurrentTurn() {
    this.currentTurn = null;
    delete this.state.processing;
    this.saveState();
  }

  async clearWorkingReaction() {
    const messageId = this.currentIncomingMessageId();
    const emoji = safeString(this.workingReactionEmoji).trim();
    this.workingReactionEmoji = "";
    this.workingReactionTick = 0;
    this.lastWorkingReactionAt = 0;
    if (!messageId || !emoji) return false;
    return await clearWorkingReactionTick(
      this.app,
      this.chatKey,
      messageId,
      emoji,
    );
  }

  private getWorkingIndicatorPolicy() {
    const parsed = parseChatKey(this.chatKey);
    if (!parsed) {
      return { typing: false, reaction: false, notice: false };
    }
    if (parsed.platform === "telegram") {
      return { typing: true, reaction: true, notice: false };
    }
    if (parsed.platform === "discord") {
      return { typing: true, reaction: false, notice: false };
    }
    if (parsed.platform === "onebot") {
      return isPrivateChat(parsed)
        ? { typing: false, reaction: false, notice: true }
        : { typing: false, reaction: true, notice: false };
    }
    return { typing: false, reaction: false, notice: true };
  }

  private shouldRefreshWorkingReaction() {
    return (
      !safeString(this.workingReactionEmoji).trim() ||
      Date.now() - this.lastWorkingReactionAt >= WORKING_REACTION_FRAME_INTERVAL_MS
    );
  }

  private async sendWorkingNotice() {
    if (!this.deliveryEnabled) return false;
    const processing = this.state.processing;
    if (!processing || processing.workingNoticeSent) return false;
    const replyToMessageId = this.currentReplyToMessageId() || undefined;
    await sendOutboxPayload(
      this.app,
      this.agentDir,
      {
        type: "text_delivery",
        chatKey: this.chatKey,
        text: "Working……",
        replyToMessageId,
        sessionFile: this.currentSessionFile(),
        createdAt: new Date().toISOString(),
      },
      this.h,
    );
    if (this.currentTurn) this.currentTurn.workingNoticeSent = true;
    if (this.state.processing) this.state.processing.workingNoticeSent = true;
    this.saveState();
    return true;
  }

  private currentStatusLabel() {
    return this.frontendPhase;
  }

  private buildStatusText() {
    const lines = [`Status: ${this.currentStatusLabel()}`, `Chat: ${this.chatKey}`];
    const policy = this.getWorkingIndicatorPolicy();
    const indicators = [
      policy.typing ? "typing" : "",
      policy.reaction ? "reaction" : "",
      policy.notice ? "notice" : "",
    ].filter(Boolean);
    lines.push(`Indicators: ${indicators.join(", ") || "none"}`);

    const sessionFile = this.currentSessionFile();
    if (sessionFile) lines.push(`Session file: ${sessionFile}`);

    const currentTurn = this.currentTurn || this.state.processing;
    if (currentTurn?.startedAt) {
      lines.push(
        `Since: ${prettyMilliseconds(Math.max(0, Date.now() - currentTurn.startedAt), {
          secondsDecimalDigits: 0,
          unitCount: 2,
        })}`,
      );
    }
    const replyToMessageId = this.currentReplyToMessageId();
    if (replyToMessageId) lines.push(`Reply target: ${replyToMessageId}`);
    const promptPreview = summarizePromptText(this.latestAssistantText || "");
    if (promptPreview) lines.push(`Latest: ${promptPreview}`);
    return lines.join("\n");
  }

  private async runLocalStatusCommand(replyToMessageId = "", incomingMessageId = "") {
    const text = this.buildStatusText();
    this.markProcessedMessage(incomingMessageId);
    this.latestAssistantText = text;
    if (!this.deliveryEnabled) return { handled: true, text, local: true };
    await sendOutboxPayload(
      this.app,
      this.agentDir,
      {
        type: "text_delivery",
        chatKey: this.chatKey,
        text,
        replyToMessageId: safeString(replyToMessageId).trim() || undefined,
        sessionFile: this.currentSessionFile(),
        createdAt: new Date().toISOString(),
      },
      this.h,
    );
    return { handled: true, text, local: true };
  }

  async pollTyping() {
    if (!this.deliveryEnabled) return false;
    if (!this.hasActiveTurn()) {
      await this.clearWorkingReaction().catch(() => {});
      return false;
    }
    const policy = this.getWorkingIndicatorPolicy();
    let sent = false;
    if (policy.typing) {
      sent = (await sendTyping(this.app, this.chatKey, this.h)) || sent;
    }
    const messageId = this.currentIncomingMessageId();
    if (policy.reaction && messageId && this.shouldRefreshWorkingReaction()) {
      const previousEmoji = this.workingReactionEmoji;
      const nextEmoji = await rotateWorkingReaction(
        this.app,
        this.chatKey,
        messageId,
        this.workingReactionTick,
        previousEmoji,
      );
      if (nextEmoji) {
        sent = true;
        this.workingReactionEmoji = nextEmoji;
        this.lastWorkingReactionAt = Date.now();
        if (nextEmoji !== previousEmoji) {
          this.workingReactionTick += 1;
        }
      }
    }
    if (policy.notice) {
      sent = (await this.sendWorkingNotice().catch(() => false)) || sent;
    }
    return sent;
  }

  private async runExclusiveTurn<T>(run: () => Promise<T>) {
    const previous = this.turnQueue;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.turnQueue = previous.then(() => slot);
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  private startLiveTurn(requestTag?: string) {
    if (this.liveTurn) throw new Error("chat_turn_already_running");
    let resolve!: (value: any) => void;
    let reject!: (error: Error) => void;
    const liveTurn = {
      requestTag,
      promise: new Promise<any>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      }),
      resolve: (value: any) => {
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        resolve(value);
      },
      reject: (error: Error) => {
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        reject(error);
      },
    };
    this.liveTurn = liveTurn;
    return liveTurn;
  }

  private failLiveTurn(error: Error) {
    if (!this.liveTurn) return;
    const liveTurn = this.liveTurn;
    this.liveTurn = null;
    liveTurn.reject(error);
  }

  private resetTurnTextTracking() {
    this.pendingCompletedAssistantText = "";
    this.deliveredInterimTexts.clear();
    this.interimDeliveryQueue = Promise.resolve();
  }

  private collectFinalAssistantText() {
    return resolveTurnCompletion({
      messages: Array.isArray(this.session?.messages) ? this.session.messages : [],
    }).finalText;
  }

  private queueInterimDelivery(run: () => Promise<void>) {
    const queued = this.interimDeliveryQueue.then(run, run);
    this.interimDeliveryQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async waitForInterimDeliveries() {
    await this.interimDeliveryQueue;
  }

  private async flushPendingAssistantInterim() {
    const text = safeString(this.pendingCompletedAssistantText).trim();
    this.pendingCompletedAssistantText = "";
    if (!text) return false;
    if (this.deliveredInterimTexts.has(text)) return false;
    this.deliveredInterimTexts.add(text);
    if (!this.deliveryEnabled) return true;
    const replyToMessageId = this.currentReplyToMessageId();
    await sendOutboxPayload(
      this.app,
      this.agentDir,
      {
        type: "text_delivery",
        createdAt: new Date().toISOString(),
        chatKey: this.chatKey,
        text: `${INTERIM_PREFIX}${text}`,
        replyToMessageId: replyToMessageId || undefined,
        sessionFile: this.currentSessionFile(),
      },
      this.h,
    ).catch(() => {});
    return true;
  }

  private promotePendingAssistantMessageToInterim() {
    if (!safeString(this.pendingCompletedAssistantText).trim()) return;
    void this.queueInterimDelivery(async () => {
      await this.flushPendingAssistantInterim();
    }).catch(() => {});
  }

  private async handleAssistantMessageEnd(message: any) {
    const text = safeString(extractTextFromContent(message?.content)).trim();
    if (!text) return;
    if (safeString(this.pendingCompletedAssistantText).trim()) {
      await this.queueInterimDelivery(async () => {
        await this.flushPendingAssistantInterim();
      });
    }
    this.pendingCompletedAssistantText = text;
    this.latestAssistantText = text;
  }

  private shouldAffectChatBinding() {
    return this.affectChatBinding;
  }

  currentSessionId() {
    return safeString(
      this.session?.sessionManager?.getSessionId?.() || "",
    ).trim();
  }

  private currentSessionFile() {
    const live = safeString(
      this.session?.sessionManager?.getSessionFile?.() || "",
    ).trim();
    if (live) return live;
    return resolveStoredSessionFile(this.agentDir, this.state.piSessionFile);
  }

  private pickStoredValue(...candidates: unknown[]) {
    for (const candidate of candidates) {
      const value = safeString(candidate).trim();
      if (value) return value;
    }
    return undefined;
  }

  private updateStoredSessionFile(...candidates: unknown[]) {
    const picked = this.pickStoredValue(...candidates, this.state.piSessionFile);
    this.state.piSessionFile = toStoredSessionFile(this.agentDir, picked);
    return this.state.piSessionFile;
  }

  private getRecoverableSessionFile() {
    const wanted = resolveStoredSessionFile(this.agentDir, this.state.piSessionFile);
    if (!wanted) return "";
    if (fs.existsSync(wanted)) return wanted;
    delete this.state.piSessionFile;
    this.saveState();
    return "";
  }

  private markAcceptedMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return;
    const acceptedAt = new Date().toISOString();
    const sessionFile = this.currentSessionFile();
    if (!sessionFile) return;
    markProcessedChatMessage(this.agentDir, this.chatKey, nextMessageId, {
      sessionFile,
      acceptedAt,
    });
  }

  private markProcessedMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return;
    markProcessedChatMessage(this.agentDir, this.chatKey, nextMessageId, {
      sessionFile: this.currentSessionFile(),
      acceptedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
    });
  }

  private buildAssistantDelivery(input: {
    text?: string;
    replyToMessageId?: string;
    sessionFile?: string;
  }) {
    const text = safeString(input.text ?? this.latestAssistantText).trim();
    if (!text) throw new Error("chat_final_assistant_text_missing");
    return {
      type: "text_delivery" as const,
      chatKey: this.chatKey,
      text,
      replyToMessageId:
        safeString(input.replyToMessageId || "").trim() || undefined,
      sessionFile: toStoredSessionFile(
        this.agentDir,
        input.sessionFile || this.currentSessionFile(),
      ),
    };
  }

  private stageAssistantDelivery(input: {
    text?: string;
    replyToMessageId?: string;
    sessionFile?: string;
  }) {
    const text = safeString(input.text ?? this.latestAssistantText).trim();
    if (!text) throw new Error("chat_final_assistant_text_missing");
    this.latestAssistantText = text;
    this.state.pendingDelivery = this.buildAssistantDelivery(input);
    return text;
  }

  private async commitPendingDelivery(clearProcessing = false) {
    const pending = this.state.pendingDelivery;
    if (!pending) return;
    if (!this.deliveryEnabled) {
      delete this.state.pendingDelivery;
      if (clearProcessing) {
        await this.clearWorkingReaction().catch(() => {});
        delete this.state.processing;
        this.currentTurn = null;
      }
      this.saveState();
      return;
    }
    await sendOutboxPayload(
      this.app,
      this.agentDir,
      {
        ...pending,
        createdAt: new Date().toISOString(),
      },
      this.h,
    );
    delete this.state.pendingDelivery;
    if (clearProcessing) {
      await this.clearWorkingReaction().catch(() => {});
      delete this.state.processing;
      this.currentTurn = null;
    }
    this.saveState();
  }

  private async deliverAssistantReply(input: {
    text?: string;
    replyToMessageId?: string;
    incomingMessageId?: string;
    sessionFile?: string;
    clearProcessing?: boolean;
  }) {
    const text = this.stageAssistantDelivery(input);
    this.saveState();
    this.markProcessedMessage(input.incomingMessageId);
    await this.commitPendingDelivery(input.clearProcessing);
    return text;
  }

  private async finishLiveTurn(input: {
    liveTurn: { promise: Promise<any> };
    replyToMessageId?: string;
    incomingMessageId?: string;
  }) {
    const completion = await input.liveTurn.promise;
    await this.waitForInterimDeliveries();
    const canonicalCompletion = resolveTurnCompletion({
      ...completion,
      messages: Array.isArray(this.session?.messages) ? this.session.messages : [],
    });
    const finalText =
      safeString((completion as any)?.finalText).trim() ||
      safeString(canonicalCompletion.finalText).trim();
    if (!finalText) {
      throw new Error("rpc_turn_final_output_missing");
    }
    this.updateStoredSessionFile(
      completion?.sessionFile,
      this.session?.sessionManager?.getSessionFile?.(),
    );
    await this.deliverAssistantReply({
      text: finalText,
      replyToMessageId: input.replyToMessageId,
      sessionFile: completion?.sessionFile,
      incomingMessageId: input.incomingMessageId,
      clearProcessing: true,
    });
    this.clearCurrentTurn();
    return { completion, result: canonicalCompletion.result, finalText };
  }

  async resumeSessionFile(sessionFile: string) {
    const wanted = safeString(sessionFile).trim();
    if (!wanted)
      return {
        changed: false,
        sessionId: this.currentSessionId() || undefined,
      };
    if (!fs.existsSync(wanted)) {
      delete this.state.piSessionFile;
      this.saveState();
      return {
        changed: false,
        sessionId: this.currentSessionId() || undefined,
      };
    }
    await this.connect();
    if (!this.session) return { changed: false, sessionId: undefined };
    const before = safeString(
      this.session.sessionManager.getSessionFile?.() || "",
    ).trim();
    if (before !== wanted) await this.session.switchSession(wanted);
    this.updateStoredSessionFile(
      this.session.sessionManager.getSessionFile?.(),
      wanted,
    );
    this.saveState();
    return {
      changed: before !== wanted,
      sessionId: this.currentSessionId() || undefined,
      sessionFile:
        safeString(
          this.session.sessionManager.getSessionFile?.() || "",
        ).trim() || undefined,
    };
  }

  private async ensureSessionReady() {
    if (!this.session) throw new Error("chat_session_not_connected");
    const wanted = this.getRecoverableSessionFile();
    const current = safeString(
      this.session.sessionManager.getSessionFile?.() || "",
    ).trim();
    if (!current && wanted) {
      await this.session.switchSession(wanted);
    }
    const result = await this.session.ensureSessionReady();
    this.updateStoredSessionFile(
      this.session.sessionManager.getSessionFile?.(),
      result?.sessionFile,
    );
    this.saveState();
    return result;
  }

  async runCommand(
    commandLine: string,
    replyToMessageId = "",
    incomingMessageId = "",
  ) {
    const commandName = commandNameFromCommandLine(commandLine);
    if (commandName === "status") {
      return await this.runLocalStatusCommand(replyToMessageId, incomingMessageId);
    }
    const skipSessionRecovery = commandName === "new";
    await this.connect({ restoreSession: !skipSessionRecovery });
    if (!this.session) throw new Error("chat_session_not_connected");
    if (!skipSessionRecovery) {
      await this.ensureSessionReady();
    }
    this.setCurrentTurn({
      text: commandLine,
      attachments: [],
      incomingMessageId: incomingMessageId || undefined,
      replyToMessageId: replyToMessageId || undefined,
    });
    try {
      const data: any = await this.session.runCommand(commandLine);
      this.updateStoredSessionFile(this.session.sessionManager.getSessionFile?.());
      const text = safeString(data?.text || "").trim();
      if (!text) throw new Error("chat_command_text_missing");
      await this.deliverAssistantReply({
        text,
        replyToMessageId: replyToMessageId || undefined,
        incomingMessageId,
      });
      return data;
    } catch (error: any) {
      if (!isTransientChatRuntimeError(error)) {
        const errorMessage =
          safeString(error?.message || error).trim() || "chat_command_failed";
        await this.deliverAssistantReply({
          text: `Chat bridge error: ${errorMessage}`,
          replyToMessageId: replyToMessageId || undefined,
          incomingMessageId,
        });
      }
      throw error;
    } finally {
      await this.clearWorkingReaction().catch(() => {});
      this.clearCurrentTurn();
      this.saveState();
    }
  }

  private async sendPromptLikeTui(input: {
    text: string;
    attachments: SavedAttachment[];
    replyToMessageId?: string;
    incomingMessageId?: string;
  }) {
    await this.connect();
    if (!this.session) throw new Error("chat_session_not_connected");
    await this.ensureSessionReady();
    const { text, images } = await restorePromptParts({
      text: input.text,
      attachments: input.attachments,
      startedAt: Date.now(),
    });
    this.setCurrentTurn({
      text: input.text,
      attachments: input.attachments,
      incomingMessageId: input.incomingMessageId,
      replyToMessageId: input.replyToMessageId,
    });
    void this.pollTyping().catch(() => {});
    if (this.session.isStreaming) {
      await this.session.prompt(text, {
        images,
        source: "chat-bridge",
        streamingBehavior: "steer",
      });
      this.markAcceptedMessage(input.incomingMessageId);
      return {
        steered: true,
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile(),
      };
    }
    this.latestAssistantText = "";
    const requestTag = this.createTurnRequestTag();
    const liveTurn = this.startLiveTurn(requestTag);
    try {
      await this.session.prompt(text, {
        images,
        source: "chat-bridge",
        requestTag,
      });
    } catch (error: any) {
      if (isAgentAlreadyProcessingError(error)) {
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        await this.session.prompt(text, {
          images,
          source: "chat-bridge",
          streamingBehavior: "steer",
        });
        this.markAcceptedMessage(input.incomingMessageId);
        return {
          steered: true,
          sessionId: this.currentSessionId() || undefined,
          sessionFile: this.currentSessionFile(),
        };
      }
      this.failLiveTurn(
        error instanceof Error
          ? error
          : new Error(String(error || "chat_turn_failed")),
      );
      await this.clearWorkingReaction().catch(() => {});
      this.clearCurrentTurn();
      throw error;
    }
    const { finalText, result } = await this.finishLiveTurn({
      liveTurn,
      replyToMessageId: input.replyToMessageId,
      incomingMessageId: input.incomingMessageId,
    });
    return {
      finalText,
      result,
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile(),
    };
  }

  async runTurn(
    input: {
      text: string;
      attachments: SavedAttachment[];
      replyToMessageId?: string;
      incomingMessageId?: string;
      sessionFile?: string;
    },
    _mode: "prompt" | "steer" = "prompt",
  ) {
    return await this.runExclusiveTurn(async () => {
      await this.connect();
      if (!this.session) throw new Error("chat_session_not_connected");
      const { sessionFile: wantedSessionFile } = normalizeSessionRef(input);
      if (wantedSessionFile) {
        await this.resumeSessionFile(wantedSessionFile);
      }
      return await this.sendPromptLikeTui(input);
    });
  }

  async housekeep() {
    await this.pollTyping().catch(() => {});
  }

  async recoverIfNeeded() {
    return;
  }

  async handleClientEvent(event: any) {
    if (!event || typeof event !== "object") return;
    const payload = event.type === "ui" ? event.payload : event;
    await this.handleSessionEvent(payload);
  }

  private async handleSessionEvent(event: any) {
    if (!event || typeof event !== "object") return;
    if (event.type === "rpc_frontend_status") {
      this.frontendPhase = safeString(event.phase).trim() as any || "idle";
      if (this.frontendPhase === "sending" || this.frontendPhase === "working") {
        this.markAcceptedMessage(this.currentIncomingMessageId());
      }
      if (this.frontendPhase === "idle") {
        await this.clearWorkingReaction().catch(() => {});
      }
      return;
    }
    if (event.type === "rpc_turn_event") {
      if (event.event === "start" || event.event === "heartbeat") {
        this.markAcceptedMessage(this.currentIncomingMessageId());
        return;
      }
      if (event.event === "complete") {
        if (!this.liveTurn) return;
        const current = safeString(this.liveTurn.requestTag || "").trim();
        const incoming = safeString(event.requestTag || "").trim();
        if (current && incoming && current !== incoming) return;
        const completion = resolveTurnCompletion(event);
        const finalText =
          safeString(event.finalText).trim() ||
          safeString(completion.finalText).trim();
        if (!finalText) {
          this.failLiveTurn(new Error("rpc_turn_final_output_missing"));
          return;
        }
        this.latestAssistantText = finalText;
        const session = normalizeSessionRef(event);
        this.liveTurn.resolve({
          finalText,
          result: completion.result,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
        });
        return;
      }
      if (event.event === "error") {
        this.failLiveTurn(new Error(String(event.error || "rpc_turn_failed")));
        return;
      }
    }
    switch (event.type) {
      case "agent_start":
        this.resetTurnTextTracking();
        this.latestAssistantText = "";
        this.markAcceptedMessage(this.currentIncomingMessageId());
        break;
      case "message_end":
        if (event?.message?.role === "assistant") {
          await this.handleAssistantMessageEnd(event.message).catch(() => {});
          break;
        }
        this.promotePendingAssistantMessageToInterim();
        break;
      case "message_update":
        if (event?.message?.role === "assistant") {
          this.promotePendingAssistantMessageToInterim();
        }
        break;
      case "tool_execution_end":
      case "tool_execution_start":
      case "compaction_start":
      case "compaction_end":
        this.markAcceptedMessage(this.currentIncomingMessageId());
        this.promotePendingAssistantMessageToInterim();
        break;
    }
  }
}

export function loadChatSettings(settingsPath: string) {
  const settings: any = readJsonFile(settingsPath, {}) || {};
  if (settings.enableSkillCommands == null) settings.enableSkillCommands = true;
  return settings;
}
