import path from "node:path";

import { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";
import { RpcInteractiveSession } from "../rin-tui/runtime.js";
import { chatStatePath } from "../chat-bridge/session-binding.js";
import { parseChatKey, readJsonFile, writeJsonFile } from "./support.js";
import {
  KoishiChatState,
  SavedAttachment,
  extractTextFromContent,
  markProcessedKoishiMessage,
  safeString,
} from "./chat-helpers.js";
import { appendKoishiChatLog } from "./chat-log.js";
import {
  buildPromptText,
  recordDeliveredAssistantMessages,
  restorePromptParts,
  sendText,
  sendTyping,
} from "./transport.js";

const INTERIM_PREFIX = "··· ";
const TYPING_INTERVAL_MS = 4000;
const INTERIM_MIN_INTERVAL_MS = 1500;
const DEFAULT_PRIVATE_IDLE_TOOL_PROGRESS_INTERVAL_MS = 10_000;
const DEFAULT_GROUP_IDLE_TOOL_PROGRESS_INTERVAL_MS = 30_000;
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
  turnSeq = 0;
  activeTag = "";
  turnWaiters = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  interimText = "";
  interimSentText = "";
  interimSentAt = 0;
  typingTimer: NodeJS.Timeout | null = null;
  pendingCompletedAssistantText = "";
  latestAssistantText = "";
  logger: any;
  h: any;
  deliveryEnabled: boolean;
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
      statePath?: string;
      idleToolProgressConfig?: KoishiIdleToolProgressConfig;
    },
  ) {
    this.app = app;
    this.chatKey = chatKey;
    this.dataDir = dataDir;
    this.agentDir = path.resolve(dataDir, "..");
    this.deliveryEnabled = deps.deliveryEnabled !== false;
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
      if (event.type !== "ui") return;
      const payload: any = event.payload;
      if (payload?.type !== "rpc_turn_event") return;
      const requestTag = safeString(payload.requestTag || "").trim();
      const waiter = this.turnWaiters.get(requestTag);
      if (!waiter) return;
      if (payload.event === "complete") {
        this.turnWaiters.delete(requestTag);
        waiter.resolve(payload);
      } else if (payload.event === "error") {
        this.turnWaiters.delete(requestTag);
        waiter.reject(new Error(String(payload.error || "rpc_turn_failed")));
      }
    });

    session.subscribe((event: any) => {
      switch (event?.type) {
        case "agent_start":
          this.interimText = "";
          this.interimSentText = "";
          this.pendingCompletedAssistantText = "";
          this.latestAssistantText = "";
          this.lastVisibleProgressAt = Date.now();
          this.lastIdleToolProgressAt = 0;
          this.lastToolCallSummary = "";
          this.startTyping();
          this.scheduleIdleToolProgress();
          break;
        case "message_update":
          if (event?.message?.role !== "assistant") break;
          {
            const nextText = extractTextFromContent(event.message.content);
            if (nextText) this.interimText = nextText;
          }
          break;
        case "message_end": {
          if (event?.message?.role !== "assistant") break;
          const finalText = extractTextFromContent(event.message.content);
          if (finalText) {
            this.latestAssistantText = finalText;
            this.pendingCompletedAssistantText = finalText;
          }
          break;
        }
        case "tool_execution_start":
          this.lastToolCallSummary = summarizeKoishiToolCall(
            safeString(event?.toolName).trim(),
            event?.args,
          );
          this.scheduleIdleToolProgress();
          if (this.pendingCompletedAssistantText)
            void this.flushInterim().catch(() => {});
          break;
        case "tool_execution_end":
        case "compaction_start":
        case "compaction_end":
          if (this.pendingCompletedAssistantText)
            void this.flushInterim().catch(() => {});
          break;
        case "agent_end":
          this.stopTyping();
          this.clearIdleToolProgressTimer();
          break;
      }
    });

    const wantedSessionFile = safeString(this.state.piSessionFile || "").trim();
    if (wantedSessionFile)
      await session.switchSession(wantedSessionFile).catch(() => {});
    if (this.deliveryEnabled && !session.sessionManager.getSessionName?.())
      await session.setSessionName(this.chatKey);
  }

  dispose() {
    this.stopTyping();
    this.clearIdleToolProgressTimer();
    for (const waiter of this.turnWaiters.values())
      waiter.reject(new Error("koishi_controller_disposed"));
    this.turnWaiters.clear();
    void this.session?.disconnect().catch(() => {});
    this.client = null;
    this.session = null;
  }

  private saveState() {
    writeJsonFile(this.statePath, this.state);
  }
  private startTyping() {
    if (!this.deliveryEnabled) return;
    this.stopTyping();
    void sendTyping(this.app, this.chatKey, this.h);
    this.typingTimer = setInterval(() => {
      void sendTyping(this.app, this.chatKey, this.h);
    }, TYPING_INTERVAL_MS);
  }
  private stopTyping() {
    if (!this.typingTimer) return;
    clearInterval(this.typingTimer);
    this.typingTimer = null;
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
    await sendText(
      this.app,
      this.chatKey,
      `${INTERIM_PREFIX}${nextText}`,
      this.h,
      replyToMessageId,
    )
      .then((deliveryResult) => {
        recordDeliveredAssistantMessages(this.agentDir, {
          chatKey: this.chatKey,
          deliveryResult,
          text: `${INTERIM_PREFIX}${nextText}`,
          rawContent: `${INTERIM_PREFIX}${nextText}`,
          replyToMessageId: replyToMessageId || undefined,
          sessionId: this.currentSessionId() || undefined,
          sessionFile:
            safeString(
              this.session?.sessionManager?.getSessionFile?.() ||
                this.state.piSessionFile ||
                "",
            ).trim() || undefined,
        });
      })
      .catch(() => {});
    return true;
  }
  async flushInterim(force = false) {
    const text = safeString(this.pendingCompletedAssistantText || "").trim();
    if (!text) return;
    this.pendingCompletedAssistantText = "";
    await this.emitProgressText(text, {
      force,
      minIntervalMs: INTERIM_MIN_INTERVAL_MS,
    });
  }
  async handleIdleToolProgressTick(now = Date.now()) {
    this.idleToolProgressTimer = null;
    if (!this.deliveryEnabled) return;
    const summary = safeString(this.lastToolCallSummary).trim();
    const intervalMs = this.idleToolProgressIntervalMs();
    if (!summary) {
      this.scheduleIdleToolProgress();
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
  private nextRequestTag() {
    this.turnSeq += 1;
    return `${this.chatKey}:${Date.now()}:${this.turnSeq}`;
  }
  currentSessionId() {
    return safeString(
      this.session?.sessionManager?.getSessionId?.() || "",
    ).trim();
  }
  private logAssistantText(text: string, replyToMessageId = "") {
    if (!this.deliveryEnabled) return;
    const nextText = safeString(text).trim();
    if (!nextText) return;
    appendKoishiChatLog(this.agentDir, {
      timestamp: new Date().toISOString(),
      chatKey: this.chatKey,
      role: "assistant",
      text: nextText,
      replyToMessageId: safeString(replyToMessageId).trim() || undefined,
      sessionId: this.currentSessionId() || undefined,
      sessionFile:
        safeString(
          this.session?.sessionManager?.getSessionFile?.() ||
            this.state.piSessionFile ||
            "",
        ).trim() || undefined,
    });
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
  private async deliverFinalAssistantText(replyToMessageId = "") {
    const text = safeString(this.latestAssistantText || "").trim();
    if (!text) throw new Error("koishi_final_assistant_text_missing");
    if (!this.deliveryEnabled) return;
    const deliveryResult = await sendText(
      this.app,
      this.chatKey,
      text,
      this.h,
      replyToMessageId,
    );
    this.logAssistantText(text, replyToMessageId);
    recordDeliveredAssistantMessages(this.agentDir, {
      chatKey: this.chatKey,
      deliveryResult,
      text,
      rawContent: text,
      replyToMessageId: replyToMessageId || undefined,
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile(),
    });
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
    await this.connect();
    if (!this.session) return { changed: false, sessionId: undefined };
    const before = safeString(
      this.session.sessionManager.getSessionFile?.() || "",
    ).trim();
    if (before !== wanted)
      await this.session.switchSession(wanted).catch(() => {});
    if (this.deliveryEnabled && !this.session.sessionManager.getSessionName?.())
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
  private waitForTurn(tag: string) {
    return new Promise<any>((resolve, reject) => {
      this.turnWaiters.set(tag, { resolve, reject });
    });
  }
  private async ensureSessionReady() {
    if (!this.session) throw new Error("koishi_session_not_connected");
    const wanted = safeString(this.state.piSessionFile || "").trim();
    const current = safeString(
      this.session.sessionManager.getSessionFile?.() || "",
    ).trim();
    if (!current && wanted) {
      await this.session.switchSession(wanted).catch(() => {});
    }
    const result = await this.session.ensureSessionReady();
    this.state.piSessionFile =
      safeString(
        this.session.sessionManager.getSessionFile?.() ||
          result?.sessionFile ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined;
    if (this.deliveryEnabled && !this.session.sessionManager.getSessionName?.())
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
    if (this.deliveryEnabled && !this.session.sessionManager.getSessionName?.())
      await this.session.setSessionName(this.chatKey);
    delete this.state.processing;
    this.saveState();
    this.markProcessedMessage(incomingMessageId);
    const text = safeString(data?.text || "").trim();
    if (text) {
      const deliveryResult = await sendText(
        this.app,
        this.chatKey,
        text,
        this.h,
        replyToMessageId,
      );
      this.logAssistantText(text, replyToMessageId);
      recordDeliveredAssistantMessages(this.agentDir, {
        chatKey: this.chatKey,
        deliveryResult,
        text,
        rawContent: text,
        replyToMessageId: replyToMessageId || undefined,
        sessionId: this.currentSessionId() || undefined,
        sessionFile:
          safeString(
            this.session?.sessionManager?.getSessionFile?.() ||
              this.state.piSessionFile ||
              "",
          ).trim() || undefined,
      });
    }
    return data;
  }
  async runTurn(
    input: {
      text: string;
      attachments: SavedAttachment[];
      replyToMessageId?: string;
      incomingMessageId?: string;
      sessionFile?: string;
    },
    mode: "prompt" | "interrupt_prompt" = "prompt",
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
    const tag = this.nextRequestTag();
    this.activeTag = tag;
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
    let completionPayload: any;
    const replyToMessageId = safeString(
      this.state.processing?.replyToMessageId || input.replyToMessageId || "",
    ).trim();
    this.latestAssistantText = "";
    const completion = this.waitForTurn(tag);
    this.startTyping();
    await this.session.prompt(text, {
      images,
      requestTag: tag,
      source: "koishi-bridge",
      streamingBehavior: mode === "interrupt_prompt" ? "steer" : undefined,
    });
    completionPayload = await completion;
    if (!safeString(this.latestAssistantText || "").trim()) {
      throw new Error("final_assistant_text_missing");
    }
    if (this.activeTag !== tag) return;
    this.state.piSessionFile =
      safeString(
        completionPayload?.sessionFile ||
          this.session.sessionManager.getSessionFile?.() ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined;
    delete this.state.processing;
    this.saveState();
    this.markProcessedMessage(input.incomingMessageId);
    await this.deliverFinalAssistantText(replyToMessageId);
    return {
      finalText: safeString(this.latestAssistantText || "").trim(),
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile(),
    };
  }
  async recoverIfNeeded() {
    if (!this.state.processing) return;
    await this.connect();
    if (!this.session) return;
    const currentLastUser = [...(this.session.messages || [])]
      .reverse()
      .find((message: any) => message?.role === "user");
    const lastUserText = extractTextFromContent(currentLastUser?.content);
    const pending = this.state.processing;
    const shouldResumeInternally =
      safeString(lastUserText).trim() ===
      safeString(buildPromptText(pending.text, pending.attachments)).trim();
    this.logger.info(`resume interrupted koishi turn chatKey=${this.chatKey}`);
    if (shouldResumeInternally) {
      const tag = this.nextRequestTag();
      this.activeTag = tag;
      let completionPayload: any;
      this.latestAssistantText = "";
      const completion = this.waitForTurn(tag);
      this.startTyping();
      await this.session.resumeInterruptedTurn({
        source: "koishi-bridge",
        requestTag: tag,
      });
      completionPayload = await completion;
      if (!safeString(this.latestAssistantText || "").trim()) {
        throw new Error("final_assistant_text_missing");
      }
      if (this.activeTag !== tag) return;
      this.state.piSessionFile =
        safeString(
          completionPayload?.sessionFile ||
            this.session.sessionManager.getSessionFile?.() ||
            this.state.piSessionFile ||
            "",
        ).trim() || undefined;
      delete this.state.processing;
      this.saveState();
      await this.deliverFinalAssistantText(
        safeString(pending.replyToMessageId || "").trim(),
      );
      return;
    }
    await this.runTurn(
      {
        text: pending.text,
        attachments: pending.attachments,
        replyToMessageId: pending.replyToMessageId,
      },
      "interrupt_prompt",
    );
  }
}

export function loadKoishiSettings(settingsPath: string) {
  const settings: any = readJsonFile(settingsPath, {}) || {};
  if (settings.enableSkillCommands == null) settings.enableSkillCommands = true;
  return settings;
}
