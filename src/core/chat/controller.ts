import fs from "node:fs";
import path from "node:path";

import prettyMilliseconds from "pretty-ms";

import { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";
import { RpcInteractiveSession } from "../rin-tui/runtime.js";
import { buildTurnResultFromMessages } from "../session/turn-result.js";
import { chatStatePath } from "../chat-bridge/session-binding.js";
import { parseChatKey, readJsonFile, writeJsonFile } from "./support.js";
import {
  ChatState,
  SavedAttachment,
  extractTextFromContent,
  markProcessedChatMessage,
  safeString,
} from "./chat-helpers.js";
import {
  buildPromptText,
  clearWorkingReaction as clearWorkingReactionTick,
  restorePromptParts,
  rotateWorkingReaction,
  sendOutboxPayload,
  sendTyping,
} from "./transport.js";

const TURN_HEARTBEAT_INTERVAL_GRACE_MS = 60_000;
const TURN_RECOVERY_COOLDOWN_MS = 5_000;
const WORKING_REACTION_FRAME_INTERVAL_MS = 30_000;
const INTERIM_PREFIX = "··· ";

function extractFinalTextFromTurnResult(result: any) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (safeString((message as any).type).trim() !== "text") continue;
    const text = safeString((message as any).text).trim();
    if (text) return text;
  }
  return "";
}

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

function formatElapsedSince(startedAt: number) {
  return prettyMilliseconds(Math.max(0, Date.now() - startedAt), {
    secondsDecimalDigits: 0,
    unitCount: 2,
  });
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
  lastTurnPulseAt = 0;
  lastRecoveryAttemptAt = 0;
  logger: any;
  h: any;
  deliveryEnabled: boolean;
  affectChatBinding: boolean;
  workingReactionEmoji = "";
  workingReactionTick = 0;
  lastWorkingReactionAt = 0;

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
  }

  async connect(options: { restoreSession?: boolean } = {}) {
    if (this.session && this.client) return;
    const client = new RinDaemonFrontendClient();
    const session = new RpcInteractiveSession(client);
    await session.connect();
    this.client = client;
    this.session = session;

    client.subscribe((event) => {
      this.handleClientEvent(event);
    });

    session.subscribe((event: any) => {
      this.handleSessionEvent(event);
    });

    if (options.restoreSession === false) return;
    const wantedSessionFile = this.getRecoverableSessionFile();
    if (wantedSessionFile) {
      await session.switchSession(wantedSessionFile);
    }
  }

  dispose() {
    void this.clearWorkingReaction().catch(() => {});
    this.failLiveTurn(new Error("chat_controller_disposed"));
    void this.session?.disconnect().catch(() => {});
    this.client = null;
    this.session = null;
  }

  private createTurnRequestTag() {
    return `chat_turn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  private markTurnPulse() {
    this.lastTurnPulseAt = Date.now();
  }

  private clearTurnPulse() {
    this.lastTurnPulseAt = 0;
  }

  private matchesLiveTurnRequestTag(requestTag: unknown) {
    const current = safeString(this.liveTurn?.requestTag || "").trim();
    const incoming = safeString(requestTag).trim();
    if (!current || !incoming) return true;
    return current === incoming;
  }

  private isTurnStale() {
    if (!this.liveTurn) return false;
    if (!this.lastTurnPulseAt) return false;
    return Date.now() - this.lastTurnPulseAt > TURN_HEARTBEAT_INTERVAL_GRACE_MS;
  }

  handleClientEvent(event: any) {
    if (event?.type !== "ui") return;
    if (event.name === "connection_lost") {
      this.failLiveTurn(new Error("rin_disconnected:rpc_turn"));
      return;
    }
    if (event.name === "worker_exit") {
      const payload: any = event.payload || {};
      this.failLiveTurn(
        new Error(
          `rin_worker_exit:code=${String(payload.code ?? "null")}:signal=${String(payload.signal ?? "null")}`,
        ),
      );
      return;
    }
    const payload: any = event.payload;
    if (payload?.type !== "rpc_turn_event") return;
    if (!this.matchesLiveTurnRequestTag(payload.requestTag)) return;
    if (
      payload.event === "start" ||
      payload.event === "heartbeat" ||
      payload.event === "complete"
    ) {
      this.markTurnPulse();
      this.markAcceptedMessage(this.currentIncomingMessageId());
    }
    if (payload.event === "complete") {
      const finalText = safeString(payload.finalText).trim();
      if (!finalText) {
        this.failLiveTurn(new Error("rpc_turn_final_output_missing"));
        return;
      }
      if (finalText) this.latestAssistantText = finalText;
      this.liveTurn?.resolve({
        finalText,
        result: payload.result,
        sessionId: safeString(payload.sessionId).trim() || undefined,
        sessionFile: safeString(payload.sessionFile).trim() || undefined,
      });
      return;
    }
    if (payload.event === "error") {
      this.failLiveTurn(new Error(String(payload.error || "rpc_turn_failed")));
    }
  }

  handleSessionEvent(event: any) {
    switch (event?.type) {
      case "agent_start":
        this.resetTurnTextTracking();
        this.latestAssistantText = "";
        this.markTurnPulse();
        this.markAcceptedMessage(this.currentIncomingMessageId());
        break;
      case "agent_end":
        this.markTurnPulse();
        break;
      case "message_end":
        this.markTurnPulse();
        if (event?.message?.role === "assistant") {
          void this.handleAssistantMessageEnd(event.message).catch(() => {});
          break;
        }
        this.promotePendingAssistantMessageToInterim();
        break;
      case "message_update":
        this.markTurnPulse();
        if (event?.message?.role === "assistant") {
          this.promotePendingAssistantMessageToInterim();
        }
        break;
      case "tool_execution_end":
      case "tool_execution_start":
      case "compaction_start":
      case "compaction_end":
        this.markTurnPulse();
        this.markAcceptedMessage(this.currentIncomingMessageId());
        this.promotePendingAssistantMessageToInterim();
        break;
    }
  }

  private saveState() {
    writeJsonFile(this.statePath, this.state);
  }
  async clearProcessingState() {
    await this.clearWorkingReaction().catch(() => {});
    delete this.state.processing;
    delete this.state.pendingDelivery;
    this.saveState();
  }
  private getRecoverableSessionFile() {
    const wanted = safeString(this.state.piSessionFile || "").trim();
    if (!wanted) return "";
    if (fs.existsSync(wanted)) return wanted;
    delete this.state.piSessionFile;
    this.saveState();
    return "";
  }
  hasActiveTurn() {
    return Boolean(this.liveTurn) && !this.isTurnStale();
  }
  private currentIncomingMessageId() {
    return safeString(this.state.processing?.incomingMessageId || "").trim();
  }
  claimsInboundMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return false;
    return this.currentIncomingMessageId() === nextMessageId;
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
      return parsed.chatId.startsWith("private:")
        ? { typing: false, reaction: false, notice: true }
        : { typing: false, reaction: true, notice: false };
    }
    return { typing: false, reaction: false, notice: true };
  }
  private async sendWorkingNotice() {
    if (!this.deliveryEnabled) return false;
    const processing = this.state.processing;
    if (!processing || processing.workingNoticeSent) return false;
    const replyToMessageId =
      safeString(
        processing.replyToMessageId || processing.incomingMessageId || "",
      ).trim() || undefined;
    await sendOutboxPayload(
      this.app,
      this.agentDir,
      {
        type: "text_delivery",
        chatKey: this.chatKey,
        text: "Working……",
        replyToMessageId,
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile(),
        createdAt: new Date().toISOString(),
      },
      this.h,
    );
    processing.workingNoticeSent = true;
    this.saveState();
    return true;
  }
  private shouldRefreshWorkingReaction() {
    return (
      !safeString(this.workingReactionEmoji).trim() ||
      Date.now() - this.lastWorkingReactionAt >= WORKING_REACTION_FRAME_INTERVAL_MS
    );
  }
  private currentStatusLabel() {
    if (this.hasActiveTurn()) return "working";
    if (this.state.pendingDelivery) return "delivering";
    if (this.state.processing) return "recovering";
    return "idle";
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

    const sessionId = this.currentSessionId();
    const sessionFile = this.currentSessionFile();
    if (sessionId) lines.push(`Session: ${sessionId}`);
    else if (sessionFile) lines.push(`Session file: ${sessionFile}`);

    const processing = this.state.processing;
    if (processing?.startedAt) {
      lines.push(`Since: ${formatElapsedSince(processing.startedAt)}`);
    }
    const replyToMessageId = this.currentReplyToMessageId();
    if (replyToMessageId) lines.push(`Reply target: ${replyToMessageId}`);
    const promptPreview = summarizePromptText(processing?.text || "");
    if (promptPreview) lines.push(`Prompt: ${promptPreview}`);
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
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile(),
        createdAt: new Date().toISOString(),
      },
      this.h,
    );
    return { handled: true, text, local: true };
  }
  async pollTyping() {
    if (!this.deliveryEnabled) return false;
    if (!this.hasActiveTurn()) return false;
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
        this.clearTurnPulse();
        resolve(value);
      },
      reject: (error: Error) => {
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        this.clearTurnPulse();
        reject(error);
      },
    };
    this.liveTurn = liveTurn;
    this.markTurnPulse();
    return liveTurn;
  }
  private failLiveTurn(error: Error) {
    if (!this.liveTurn) return;
    const liveTurn = this.liveTurn;
    this.liveTurn = null;
    this.clearTurnPulse();
    liveTurn.reject(error);
  }
  private async refreshSessionMessages() {
    const session: any = this.session;
    if (!session) return;
    if (typeof session.refreshState === "function") {
      await session.refreshState({ messages: true, session: true });
      return;
    }
    if (typeof session.refreshMessages === "function") {
      await session.refreshMessages();
    }
  }
  private resetTurnTextTracking() {
    this.pendingCompletedAssistantText = "";
    this.deliveredInterimTexts.clear();
    this.interimDeliveryQueue = Promise.resolve();
  }
  private currentReplyToMessageId() {
    return safeString(
      this.state.processing?.replyToMessageId ||
        this.state.processing?.incomingMessageId ||
        "",
    ).trim();
  }
  private collectFinalAssistantText() {
    const messages = Array.isArray(this.session?.messages)
      ? this.session.messages
      : [];
    return extractFinalTextFromTurnResult(
      buildTurnResultFromMessages(messages),
    );
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
        sessionId: this.currentSessionId() || undefined,
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
    return (
      safeString(
        this.session?.sessionManager?.getSessionFile?.() ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined
    );
  }
  private buildAssistantDelivery(input: {
    text?: string;
    replyToMessageId?: string;
    sessionId?: string;
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
      sessionId: safeString(input.sessionId || "").trim() || undefined,
      sessionFile: safeString(input.sessionFile || "").trim() || undefined,
    };
  }
  private async commitPendingDelivery(clearProcessing = false) {
    const pending = this.state.pendingDelivery;
    if (!pending) return;
    if (!this.deliveryEnabled) {
      delete this.state.pendingDelivery;
      if (clearProcessing) {
        await this.clearWorkingReaction().catch(() => {});
        delete this.state.processing;
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
    }
    this.saveState();
  }
  private markAcceptedMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return;
    const acceptedAt = new Date().toISOString();
    const sessionId = this.currentSessionId() || undefined;
    const sessionFile = this.currentSessionFile();
    if (!sessionId && !sessionFile) return;
    markProcessedChatMessage(this.agentDir, this.chatKey, nextMessageId, {
      sessionId,
      sessionFile,
      acceptedAt,
    });
    if (
      this.state.processing &&
      safeString(this.state.processing.incomingMessageId || "").trim() ===
        nextMessageId
    ) {
      this.state.processing.acceptedAt = acceptedAt;
      this.saveState();
    }
  }
  private markProcessedMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return;
    markProcessedChatMessage(this.agentDir, this.chatKey, nextMessageId, {
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile(),
      acceptedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
    });
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
    this.state.piSessionFile =
      safeString(
        this.session.sessionManager.getSessionFile?.() ||
          wanted ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined;
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
    this.state.piSessionFile =
      safeString(
        this.session.sessionManager.getSessionFile?.() ||
          result?.sessionFile ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined;
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
    try {
      const data: any = await this.session.runCommand(commandLine);
      this.state.piSessionFile =
        safeString(
          this.session.sessionManager.getSessionFile?.() ||
            this.state.piSessionFile ||
            "",
        ).trim() || undefined;
      const text = safeString(data?.text || "").trim();
      if (!text) throw new Error("chat_command_text_missing");
      this.markProcessedMessage(incomingMessageId);
      this.latestAssistantText = text;
      this.state.pendingDelivery = this.buildAssistantDelivery({
        text,
        replyToMessageId: replyToMessageId || undefined,
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile(),
      });
      this.saveState();
      await this.commitPendingDelivery();
      return data;
    } catch (error: any) {
      const errorMessage =
        safeString(error?.message || error).trim() || "chat_command_failed";
      const text = `Chat bridge error: ${errorMessage}`;
      this.latestAssistantText = text;
      this.state.pendingDelivery = this.buildAssistantDelivery({
        text,
        replyToMessageId: replyToMessageId || undefined,
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile(),
      });
      this.saveState();
      await this.commitPendingDelivery();
      throw error;
    } finally {
      await this.clearWorkingReaction().catch(() => {});
      delete this.state.processing;
      this.saveState();
    }
  }
  private async runSteerNow(input: {
    text: string;
    attachments: SavedAttachment[];
    replyToMessageId?: string;
    incomingMessageId?: string;
  }) {
    await this.connect();
    if (!this.session) throw new Error("chat_session_not_connected");
    if (!this.session.isStreaming) {
      return await this.runExclusiveTurn(() =>
        this.runTurnNow(input, "prompt"),
      );
    }
    const { text, images } = await restorePromptParts({
      text: input.text,
      attachments: input.attachments,
      startedAt: Date.now(),
    });
    if (this.state.processing) {
      const nextIncomingMessageId =
        safeString(input.incomingMessageId || "").trim() || undefined;
      if (
        nextIncomingMessageId &&
        nextIncomingMessageId !== this.state.processing.incomingMessageId
      ) {
        await this.clearWorkingReaction().catch(() => {});
      }
      this.state.processing.replyToMessageId =
        safeString(input.replyToMessageId || "").trim() ||
        this.state.processing.replyToMessageId;
      this.state.processing.incomingMessageId =
        nextIncomingMessageId || this.state.processing.incomingMessageId;
      this.saveState();
    }
    await this.pollTyping().catch(() => {});
    await this.session.prompt(text, {
      images,
      source: "chat-bridge",
      streamingBehavior: "steer",
    });
    this.markProcessedMessage(input.incomingMessageId);
    return {
      steered: true,
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile(),
    };
  }
  async housekeep() {
    if (this.isTurnStale()) {
      await this.refreshSessionMessages().catch(() => {});
      if (this.session?.isStreaming || this.session?.isCompacting) {
        this.markTurnPulse();
      } else {
        this.logger.warn(
          `chat turn heartbeat stale chatKey=${this.chatKey} ageMs=${Date.now() - this.lastTurnPulseAt}`,
        );
        this.failLiveTurn(new Error("chat_turn_stale"));
      }
    }
    if (!this.hasActiveTurn()) {
      await this.clearWorkingReaction().catch(() => {});
    }
    if (this.hasActiveTurn()) return;
    if (!this.state.processing && !this.state.pendingDelivery) return;
    if (Date.now() - this.lastRecoveryAttemptAt < TURN_RECOVERY_COOLDOWN_MS) {
      return;
    }
    this.lastRecoveryAttemptAt = Date.now();
    await this.recoverIfNeeded();
  }
  private async runTurnNow(
    input: {
      text: string;
      attachments: SavedAttachment[];
      replyToMessageId?: string;
      incomingMessageId?: string;
      sessionFile?: string;
    },
    mode: "prompt" | "steer" = "prompt",
  ) {
    await this.connect();
    if (!this.session) throw new Error("chat_session_not_connected");
    const wantedSessionFile = safeString(input.sessionFile || "").trim();
    if (wantedSessionFile) await this.resumeSessionFile(wantedSessionFile);
    await this.ensureSessionReady();
    const { text, images, attachments } = await restorePromptParts({
      text: input.text,
      attachments: input.attachments,
      startedAt: Date.now(),
    });
    this.state.chatKey = this.chatKey;
    this.state.piSessionFile =
      safeString(
        this.session.sessionManager.getSessionFile?.() ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined;
    this.state.processing = {
      text: input.text,
      attachments,
      startedAt: Date.now(),
      replyToMessageId:
        safeString(input.replyToMessageId || "").trim() || undefined,
      incomingMessageId:
        safeString(input.incomingMessageId || "").trim() || undefined,
      workingNoticeSent: false,
    };
    this.saveState();
    await this.pollTyping().catch(() => {});
    const replyToMessageId = safeString(
      this.state.processing?.replyToMessageId || input.replyToMessageId || "",
    ).trim();
    this.latestAssistantText = "";
    const requestTag = this.createTurnRequestTag();
    const liveTurn = this.startLiveTurn(requestTag);
    try {
      await this.session.prompt(text, {
        images,
        source: "chat-bridge",
        streamingBehavior: mode === "steer" ? "steer" : undefined,
        requestTag,
      });
    } catch (error: any) {
      if (mode !== "steer" && isAgentAlreadyProcessingError(error)) {
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        this.clearTurnPulse();
        return await this.runSteerNow(input);
      }
      this.failLiveTurn(
        error instanceof Error
          ? error
          : new Error(String(error || "chat_turn_failed")),
      );
      throw error;
    }
    const completion = await liveTurn.promise;
    await this.waitForInterimDeliveries();
    this.latestAssistantText = safeString(completion?.finalText).trim();
    if (!this.latestAssistantText) {
      throw new Error("rpc_turn_final_output_missing");
    }
    this.state.piSessionFile =
      safeString(
        completion?.sessionFile ||
          this.session.sessionManager.getSessionFile?.() ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined;
    this.state.pendingDelivery = this.buildAssistantDelivery({
      text: this.latestAssistantText,
      replyToMessageId: replyToMessageId || undefined,
      sessionId:
        safeString(
          completion?.sessionId || this.currentSessionId() || "",
        ).trim() || undefined,
      sessionFile:
        safeString(
          completion?.sessionFile || this.currentSessionFile() || "",
        ).trim() || undefined,
    });
    this.saveState();
    this.markProcessedMessage(input.incomingMessageId);
    await this.commitPendingDelivery(true);
    return {
      finalText: safeString(this.latestAssistantText || "").trim(),
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
    mode: "prompt" | "steer" = "prompt",
  ) {
    if (mode === "steer") return await this.runSteerNow(input);
    return await this.runExclusiveTurn(() => this.runTurnNow(input, mode));
  }
  async recoverIfNeeded() {
    await this.runExclusiveTurn(async () => {
      if (this.state.pendingDelivery) {
        this.markProcessedMessage(this.currentIncomingMessageId());
        await this.commitPendingDelivery(true);
        return;
      }
      if (!this.state.processing) {
        const wantedSessionFile = this.getRecoverableSessionFile();
        if (!wantedSessionFile) return;
        await this.connect();
        if (!this.session) return;
        const currentSessionFile = safeString(
          this.session.sessionManager.getSessionFile?.() || "",
        ).trim();
        if (currentSessionFile !== wantedSessionFile) {
          await this.resumeSessionFile(wantedSessionFile);
        }
        return;
      }
      await this.connect();
      if (!this.session) return;
      await this.refreshSessionMessages().catch(() => {});
      const messages = Array.isArray(this.session.messages)
        ? this.session.messages
        : [];
      const lastUserIndex =
        [...messages]
          .map((message: any, index: number) => ({ message, index }))
          .reverse()
          .find((entry: any) => entry?.message?.role === "user")?.index ?? -1;
      const lastAssistantAfterUser = messages
        .slice(lastUserIndex + 1)
        .reverse()
        .find((message: any) => message?.role === "assistant");
      const deliveredCompletedText = lastAssistantAfterUser
        ? extractFinalTextFromTurnResult(buildTurnResultFromMessages(messages))
        : "";
      const currentLastUser = [...messages]
        .reverse()
        .find((message: any) => message?.role === "user");
      const lastUserText = extractTextFromContent(
        (currentLastUser as any)?.content,
      );
      const pending = this.state.processing;
      const shouldResumeInternally =
        safeString(lastUserText).trim() ===
        safeString(buildPromptText(pending.text, pending.attachments)).trim();
      await this.pollTyping().catch(() => {});
      this.logger.info(`resume interrupted chat turn chatKey=${this.chatKey}`);
      if (deliveredCompletedText && !this.session.isStreaming) {
        this.latestAssistantText = deliveredCompletedText;
        this.state.pendingDelivery = this.buildAssistantDelivery({
          text: this.latestAssistantText,
          replyToMessageId:
            safeString(pending.replyToMessageId || "").trim() || undefined,
          sessionId: this.currentSessionId() || undefined,
          sessionFile: this.currentSessionFile(),
        });
        this.saveState();
        this.markProcessedMessage(pending.incomingMessageId);
        await this.commitPendingDelivery(true);
        return;
      }
      if (shouldResumeInternally) {
        this.latestAssistantText = "";
        const requestTag = this.createTurnRequestTag();
        const liveTurn = this.startLiveTurn(requestTag);
        await this.pollTyping().catch(() => {});
        try {
          await this.session.resumeInterruptedTurn({
            source: "chat-bridge",
            requestTag,
          });
        } catch (error: any) {
          this.failLiveTurn(
            error instanceof Error
              ? error
              : new Error(String(error || "chat_turn_failed")),
          );
          throw error;
        }
        const completion = await liveTurn.promise;
        await this.waitForInterimDeliveries();
        this.latestAssistantText = safeString(completion?.finalText).trim();
        if (!this.latestAssistantText) {
          throw new Error("rpc_turn_final_output_missing");
        }
        this.state.piSessionFile =
          safeString(
            completion?.sessionFile ||
              this.session.sessionManager.getSessionFile?.() ||
              this.state.piSessionFile ||
              "",
          ).trim() || undefined;
        this.state.pendingDelivery = this.buildAssistantDelivery({
          text: this.latestAssistantText,
          replyToMessageId:
            safeString(pending.replyToMessageId || "").trim() || undefined,
          sessionId:
            safeString(
              completion?.sessionId || this.currentSessionId() || "",
            ).trim() || undefined,
          sessionFile:
            safeString(
              completion?.sessionFile || this.currentSessionFile() || "",
            ).trim() || undefined,
        });
        this.saveState();
        this.markProcessedMessage(pending.incomingMessageId);
        await this.commitPendingDelivery(true);
        return;
      }
      await this.runTurnNow(
        {
          text: pending.text,
          attachments: pending.attachments,
          replyToMessageId: pending.replyToMessageId,
        },
        "prompt",
      );
    });
  }
}

export function loadChatSettings(settingsPath: string) {
  const settings: any = readJsonFile(settingsPath, {}) || {};
  if (settings.enableSkillCommands == null) settings.enableSkillCommands = true;
  return settings;
}
