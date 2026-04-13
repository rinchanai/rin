import fs from "node:fs";
import path from "node:path";

import { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";
import { RpcInteractiveSession } from "../rin-tui/runtime.js";
import { buildTurnResultFromMessages } from "../session/turn-result.js";
import { chatStatePath } from "../chat-bridge/session-binding.js";
import { parseChatKey, readJsonFile, writeJsonFile } from "./support.js";
import {
  KoishiChatState,
  SavedAttachment,
  extractTextFromContent,
  markProcessedKoishiMessage,
  safeString,
} from "./chat-helpers.js";
import {
  buildPromptText,
  restorePromptParts,
  sendOutboxPayload,
  sendTyping,
} from "./transport.js";

const INTERIM_PREFIX = "··· ";
const INTERIM_MIN_INTERVAL_MS = 1500;
const DEFAULT_PRIVATE_IDLE_TOOL_PROGRESS_INTERVAL_MS = 60_000;
const DEFAULT_GROUP_IDLE_TOOL_PROGRESS_INTERVAL_MS = 60_000;
const KOISHI_WORKING_PROGRESS_TEXT = "Working";
const DEFAULT_TOOL_INPUT_PREVIEW_CHARS = 160;

export type KoishiIdleToolProgressConfig = {
  privateIntervalMs: number;
  groupIntervalMs: number;
};

function normalizeIntervalMs(value: unknown, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.max(1000, Math.floor(next));
}

function shortenPreview(value: unknown, maxChars = DEFAULT_TOOL_INPUT_PREVIEW_CHARS) {
  const text = safeString(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function summarizeGenericArgs(args: any) {
  if (args == null) return "";
  if (typeof args === "string") return shortenPreview(args);
  if (Array.isArray(args)) return `${args.length} item${args.length === 1 ? "" : "s"}`;
  if (typeof args !== "object") return shortenPreview(String(args));
  const preferredKeys = [
    "path",
    "file_path",
    "command",
    "url",
    "q",
    "query",
    "text",
    "messageId",
    "chatKey",
    "date",
    "slot",
    "name",
    "expression",
    "runAt",
  ];
  const ignoredKeys = new Set([
    "content",
    "oldText",
    "newText",
    "edits",
    "parts",
    "data",
    "images",
    "attachments",
    "baseContent",
    "prompt",
    "command",
    "text",
  ]);
  const parts: string[] = [];
  for (const key of preferredKeys) {
    const value = (args as any)?.[key];
    if (value == null) continue;
    const preview = shortenPreview(value, key === "command" || key === "text" ? 120 : 80);
    if (!preview) continue;
    parts.push(key === "path" || key === "file_path" || key === "command" || key === "url" || key === "q" || key === "query" || key === "text" ? preview : `${key}=${preview}`);
  }
  if (parts.length) return parts.join(", ");
  for (const [key, value] of Object.entries(args)) {
    if (ignoredKeys.has(key)) continue;
    if (value == null) continue;
    const preview = shortenPreview(
      typeof value === "object"
        ? Array.isArray(value)
          ? `${value.length} item${value.length === 1 ? "" : "s"}`
          : JSON.stringify(value)
        : value,
      60,
    );
    if (!preview) continue;
    parts.push(`${key}=${preview}`);
    if (parts.length >= 3) break;
  }
  return parts.join(", ");
}

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

export function summarizeKoishiToolCall(toolName: string, args: any) {
  const name = safeString(toolName).trim() || "tool";
  if (name === "bash") {
    const command = shortenPreview(args?.command, 120);
    return command ? `bash ${command}` : "bash";
  }
  if (name === "read") {
    const target = shortenPreview(args?.path ?? args?.file_path, 100);
    const offset = Number.isFinite(Number(args?.offset)) ? Number(args.offset) : undefined;
    const limit = Number.isFinite(Number(args?.limit)) ? Number(args.limit) : undefined;
    const range =
      offset !== undefined || limit !== undefined
        ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
        : "";
    return target ? `read ${target}${range}` : "read";
  }
  if (name === "edit") {
    const target = shortenPreview(args?.path ?? args?.file_path, 100);
    const editCount = Array.isArray(args?.edits) ? args.edits.length : 0;
    const suffix = editCount > 0 ? ` (${editCount} edit${editCount === 1 ? "" : "s"})` : "";
    return target ? `edit ${target}${suffix}` : `edit${suffix}`;
  }
  if (name === "write") {
    const target = shortenPreview(args?.path ?? args?.file_path, 100);
    return target ? `write ${target}` : "write";
  }
  const summary = summarizeGenericArgs(args);
  return summary ? `${name} ${summary}` : name;
}

export function normalizeKoishiIdleToolProgressConfig(settings: any): KoishiIdleToolProgressConfig {
  const koishi = settings && typeof settings.koishi === "object" ? settings.koishi : {};
  const idleToolProgress =
    koishi && typeof koishi.idleToolProgress === "object" ? koishi.idleToolProgress : {};
  return {
    privateIntervalMs: normalizeIntervalMs(
      idleToolProgress?.privateIntervalMs,
      DEFAULT_PRIVATE_IDLE_TOOL_PROGRESS_INTERVAL_MS,
    ),
    groupIntervalMs: normalizeIntervalMs(
      idleToolProgress?.groupIntervalMs,
      DEFAULT_GROUP_IDLE_TOOL_PROGRESS_INTERVAL_MS,
    ),
  };
}

export class KoishiChatController {
  app: any;
  chatKey: string;
  dataDir: string;
  agentDir: string;
  statePath: string;
  state: KoishiChatState;
  client: RinDaemonFrontendClient | null = null;
  session: RpcInteractiveSession | null = null;
  turnQueue: Promise<void> = Promise.resolve();
  liveTurn:
    | {
        promise: Promise<any>;
        resolve: (value: any) => void;
        reject: (error: Error) => void;
      }
    | null = null;
  interimText = "";
  interimSentText = "";
  interimSentAt = 0;
  latestAssistantText = "";
  logger: any;
  h: any;
  deliveryEnabled: boolean;
  affectChatBinding: boolean;
  idleToolProgressConfig: KoishiIdleToolProgressConfig;
  idleToolProgressTimer: NodeJS.Timeout | null = null;
  lastVisibleProgressAt = 0;
  lastIdleToolProgressAt = 0;
  lastToolCallSummary = "";

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
      idleToolProgressConfig?: KoishiIdleToolProgressConfig;
    },
  ) {
    this.app = app;
    this.chatKey = chatKey;
    this.dataDir = dataDir;
    this.agentDir = path.resolve(dataDir, "..");
    this.deliveryEnabled = deps.deliveryEnabled !== false;
    this.affectChatBinding = deps.affectChatBinding !== false;
    this.statePath = deps.statePath || chatStatePath(dataDir, chatKey);
    this.state = readJsonFile<KoishiChatState>(this.statePath, { chatKey });
    this.logger = deps.logger;
    this.idleToolProgressConfig =
      deps.idleToolProgressConfig ||
      normalizeKoishiIdleToolProgressConfig(undefined);
    this.h = deps.h;
    if (!this.state.chatKey) this.state.chatKey = chatKey;
  }

  async connect() {
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

    const wantedSessionFile = this.getRecoverableSessionFile();
    if (wantedSessionFile) {
      await session.switchSession(wantedSessionFile);
      if (this.shouldAffectChatBinding() && !session.sessionManager.getSessionName?.())
        await session.setSessionName(this.chatKey);
    }
  }

  dispose() {
    this.clearIdleToolProgressTimer();
    this.failLiveTurn(new Error("koishi_controller_disposed"));
    void this.session?.disconnect().catch(() => {});
    this.client = null;
    this.session = null;
  }

  handleClientEvent(event: any) {
    if (event?.type !== "ui") return;
    if (event.name === "connection_lost") {
      this.clearIdleToolProgressTimer();
      this.failLiveTurn(new Error("rin_disconnected:rpc_turn"));
      return;
    }
    const payload: any = event.payload;
    if (payload?.type !== "rpc_turn_event") return;
    if (payload.event === "error") {
      this.failLiveTurn(new Error(String(payload.error || "rpc_turn_failed")));
    }
  }

  handleSessionEvent(event: any) {
    switch (event?.type) {
      case "agent_start":
        this.interimText = "";
        this.interimSentText = "";
        this.latestAssistantText = "";
        this.lastVisibleProgressAt = Date.now();
        this.lastIdleToolProgressAt = 0;
        this.lastToolCallSummary = KOISHI_WORKING_PROGRESS_TEXT;
        this.scheduleIdleToolProgress();
        break;
      case "message_update":
        if (event?.message?.role !== "assistant") break;
        {
          const nextText = extractTextFromContent(event.message.content);
          if (nextText) this.interimText = nextText;
        }
        break;
      case "tool_execution_start":
        this.lastToolCallSummary = KOISHI_WORKING_PROGRESS_TEXT;
        this.scheduleIdleToolProgress();
        break;
      case "agent_end":
        this.clearIdleToolProgressTimer();
        void this.completeLiveTurn().catch((error) => {
          this.failLiveTurn(
            error instanceof Error ? error : new Error(String(error || "koishi_turn_failed")),
          );
        });
        break;
      case "message_end":
      case "tool_execution_end":
      case "compaction_start":
      case "compaction_end":
        break;
    }
  }

  private saveState() {
    writeJsonFile(this.statePath, this.state);
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
    return Boolean(this.liveTurn || this.session?.isStreaming);
  }
  async pollTyping() {
    if (!this.deliveryEnabled) return false;
    if (!this.hasActiveTurn()) return false;
    await sendTyping(this.app, this.chatKey, this.h);
    return true;
  }
  private idleToolProgressIntervalMs() {
    const parsed = parseChatKey(this.chatKey);
    const chatType =
      parsed?.platform === "telegram"
        ? parsed.chatId.startsWith("-")
          ? "group"
          : "private"
        : parsed?.chatId.startsWith("private:")
          ? "private"
          : "group";
    return chatType === "private"
      ? this.idleToolProgressConfig.privateIntervalMs
      : this.idleToolProgressConfig.groupIntervalMs;
  }
  clearIdleToolProgressTimer() {
    if (!this.idleToolProgressTimer) return;
    clearTimeout(this.idleToolProgressTimer);
    this.idleToolProgressTimer = null;
  }
  scheduleIdleToolProgress() {
    this.clearIdleToolProgressTimer();
    if (!this.deliveryEnabled) return;
    const intervalMs = this.idleToolProgressIntervalMs();
    this.idleToolProgressTimer = setTimeout(() => {
      void this.handleIdleToolProgressTick().catch(() => {});
    }, intervalMs);
  }
  async emitProgressText(
    text: string,
    options: { force?: boolean; minIntervalMs?: number } = {},
  ) {
    const nextText = safeString(text).trim();
    if (!nextText) return false;
    const now = Date.now();
    if (!options.force && nextText === this.interimSentText) return false;
    if (
      !options.force &&
      now - this.interimSentAt < (options.minIntervalMs ?? INTERIM_MIN_INTERVAL_MS)
    ) {
      return false;
    }
    this.interimSentText = nextText;
    this.interimSentAt = now;
    this.lastVisibleProgressAt = now;
    if (!this.deliveryEnabled) return true;
    const replyToMessageId = safeString(
      this.state.processing?.replyToMessageId || "",
    ).trim();
    await sendOutboxPayload(
      this.app,
      this.agentDir,
      {
        type: "text_delivery",
        createdAt: new Date().toISOString(),
        chatKey: this.chatKey,
        text: `${INTERIM_PREFIX}${nextText}`,
        replyToMessageId: replyToMessageId || undefined,
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile(),
      },
      this.h,
    ).catch(() => {});
    return true;
  }
  async handleIdleToolProgressTick(now = Date.now()) {
    this.idleToolProgressTimer = null;
    if (!this.deliveryEnabled) return;
    const summary = safeString(this.lastToolCallSummary).trim() || KOISHI_WORKING_PROGRESS_TEXT;
    const intervalMs = this.idleToolProgressIntervalMs();
    if (!this.hasActiveTurn()) {
      this.clearIdleToolProgressTimer();
      return;
    }
    const lastActivityAt = Math.max(this.lastVisibleProgressAt, this.lastIdleToolProgressAt);
    if (now - lastActivityAt >= intervalMs) {
      const sent = await this.emitProgressText(summary, {
        force: true,
        minIntervalMs: 0,
      });
      if (sent) this.lastIdleToolProgressAt = now;
    }
    this.scheduleIdleToolProgress();
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
  private startLiveTurn() {
    if (this.liveTurn) throw new Error("koishi_turn_already_running");
    let resolve!: (value: any) => void;
    let reject!: (error: Error) => void;
    const liveTurn = {
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
  private collectFinalAssistantText() {
    const messages = Array.isArray(this.session?.messages)
      ? this.session.messages
      : [];
    return extractFinalTextFromTurnResult(buildTurnResultFromMessages(messages));
  }
  private async completeLiveTurn() {
    if (!this.liveTurn) return;
    await this.refreshSessionMessages().catch(() => {});
    const finalText = this.collectFinalAssistantText();
    if (finalText) this.latestAssistantText = finalText;
    this.liveTurn.resolve({
      finalText,
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile(),
    });
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
    if (!text) throw new Error("koishi_final_assistant_text_missing");
    return {
      type: "text_delivery" as const,
      chatKey: this.chatKey,
      text,
      replyToMessageId: safeString(input.replyToMessageId || "").trim() || undefined,
      sessionId: safeString(input.sessionId || "").trim() || undefined,
      sessionFile: safeString(input.sessionFile || "").trim() || undefined,
    };
  }
  private async commitPendingDelivery(clearProcessing = false) {
    const pending = this.state.pendingDelivery;
    if (!pending) return;
    if (!this.deliveryEnabled) {
      delete this.state.pendingDelivery;
      if (clearProcessing) delete this.state.processing;
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
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  }
  private markProcessedMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return;
    markProcessedKoishiMessage(this.agentDir, this.chatKey, nextMessageId, {
      sessionId: this.currentSessionId() || undefined,
      sessionFile:
        safeString(
          this.session?.sessionManager?.getSessionFile?.() ||
            this.state.piSessionFile ||
            "",
        ).trim() || undefined,
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
    if (before !== wanted)
      await this.session.switchSession(wanted);
    if (this.shouldAffectChatBinding() && !this.session.sessionManager.getSessionName?.())
      await this.session.setSessionName(this.chatKey);
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
    if (!this.session) throw new Error("koishi_session_not_connected");
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
    if (this.shouldAffectChatBinding() && !this.session.sessionManager.getSessionName?.())
      await this.session.setSessionName(this.chatKey);
    this.saveState();
    return result;
  }
  async runCommand(
    commandLine: string,
    replyToMessageId = "",
    incomingMessageId = "",
  ) {
    await this.connect();
    if (!this.session) throw new Error("koishi_session_not_connected");
    await this.ensureSessionReady();
    this.markProcessedMessage(incomingMessageId);
    const data: any = await this.session.runCommand(commandLine);
    this.state.piSessionFile =
      safeString(
        this.session.sessionManager.getSessionFile?.() ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined;
    if (this.shouldAffectChatBinding() && !this.session.sessionManager.getSessionName?.())
      await this.session.setSessionName(this.chatKey);
    delete this.state.processing;
    this.saveState();
    this.markProcessedMessage(incomingMessageId);
    const text = safeString(data?.text || "").trim();
    if (text) {
      this.latestAssistantText = text;
      this.state.pendingDelivery = this.buildAssistantDelivery({
        text,
        replyToMessageId: replyToMessageId || undefined,
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile(),
      });
      this.saveState();
      await this.commitPendingDelivery();
    }
    return data;
  }
  private async runSteerNow(input: {
    text: string;
    attachments: SavedAttachment[];
    replyToMessageId?: string;
    incomingMessageId?: string;
  }) {
    await this.connect();
    if (!this.session) throw new Error("koishi_session_not_connected");
    if (!this.session.isStreaming) {
      return await this.runExclusiveTurn(() => this.runTurnNow(input, "prompt"));
    }
    const { text, images } = await restorePromptParts({
      text: input.text,
      attachments: input.attachments,
      startedAt: Date.now(),
    });
    if (this.state.processing) {
      this.state.processing.replyToMessageId =
        safeString(input.replyToMessageId || "").trim() ||
        this.state.processing.replyToMessageId;
      this.saveState();
    }
    this.markProcessedMessage(input.incomingMessageId);
    await this.session.prompt(text, {
      images,
      source: "koishi-bridge",
      streamingBehavior: "steer",
    });
    return {
      steered: true,
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile(),
    };
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
    if (!this.session) throw new Error("koishi_session_not_connected");
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
    };
    this.saveState();
    this.markProcessedMessage(input.incomingMessageId);
    const replyToMessageId = safeString(
      this.state.processing?.replyToMessageId || input.replyToMessageId || "",
    ).trim();
    this.latestAssistantText = "";
    const liveTurn = this.startLiveTurn();
    try {
      await this.session.prompt(text, {
        images,
        source: "koishi-bridge",
        streamingBehavior: mode === "steer" ? "steer" : undefined,
      });
    } catch (error: any) {
      this.failLiveTurn(error instanceof Error ? error : new Error(String(error || "koishi_turn_failed")));
      throw error;
    }
    const completion = await liveTurn.promise;
    this.latestAssistantText = this.collectFinalAssistantText();
    if (!safeString(this.latestAssistantText || "").trim()) {
      throw new Error("final_assistant_text_missing");
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
        safeString(completion?.sessionId || this.currentSessionId() || "").trim() || undefined,
      sessionFile:
        safeString(completion?.sessionFile || this.currentSessionFile() || "").trim() || undefined,
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
        await this.commitPendingDelivery(true);
        return;
      }
      if (!this.state.processing) return;
      await this.connect();
      if (!this.session) return;
      await this.refreshSessionMessages().catch(() => {});
      const messages = Array.isArray(this.session.messages) ? this.session.messages : [];
      const lastUserIndex = [...messages]
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
      const lastUserText = extractTextFromContent(currentLastUser?.content);
      const pending = this.state.processing;
      const shouldResumeInternally =
        safeString(lastUserText).trim() ===
        safeString(buildPromptText(pending.text, pending.attachments)).trim();
      this.logger.info(`resume interrupted koishi turn chatKey=${this.chatKey}`);
      if (deliveredCompletedText && !this.session.isStreaming) {
        this.latestAssistantText = deliveredCompletedText;
        this.state.pendingDelivery = this.buildAssistantDelivery({
          text: this.latestAssistantText,
          replyToMessageId: safeString(pending.replyToMessageId || "").trim() || undefined,
          sessionId: this.currentSessionId() || undefined,
          sessionFile: this.currentSessionFile(),
        });
        this.saveState();
        await this.commitPendingDelivery(true);
        return;
      }
      if (shouldResumeInternally) {
        this.latestAssistantText = "";
        const liveTurn = this.startLiveTurn();
        try {
          await this.session.resumeInterruptedTurn({
            source: "koishi-bridge",
          });
        } catch (error: any) {
          this.failLiveTurn(error instanceof Error ? error : new Error(String(error || "koishi_turn_failed")));
          throw error;
        }
        const completion = await liveTurn.promise;
        this.latestAssistantText = this.collectFinalAssistantText();
        if (!safeString(this.latestAssistantText || "").trim()) {
          throw new Error("final_assistant_text_missing");
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
          replyToMessageId: safeString(pending.replyToMessageId || "").trim() || undefined,
          sessionId:
            safeString(completion?.sessionId || this.currentSessionId() || "").trim() || undefined,
          sessionFile:
            safeString(completion?.sessionFile || this.currentSessionFile() || "").trim() || undefined,
        });
        this.saveState();
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

export function loadKoishiSettings(settingsPath: string) {
  const settings: any = readJsonFile(settingsPath, {}) || {};
  if (settings.enableSkillCommands == null) settings.enableSkillCommands = true;
  return settings;
}
