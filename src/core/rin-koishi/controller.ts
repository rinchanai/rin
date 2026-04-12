import fs from "node:fs";
import path from "node:path";

import { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";
import { RpcInteractiveSession } from "../rin-tui/runtime.js";
import { chatStatePath } from "../chat-bridge/session-binding.js";
import { parseChatKey, readJsonFile, writeJsonFile } from "./support.js";
import {
  KoishiChatState,
  SavedAttachment,
  extractTextFromContent,
  safeString,
} from "./chat-helpers.js";
import {
  normalizeKoishiIdleToolProgressConfig,
  summarizeKoishiToolCall,
  type KoishiIdleToolProgressConfig,
} from "./progress.js";
import {
  buildAssistantDelivery,
  collectFinalAssistantText,
  commitPendingDelivery,
  markProcessedMessage,
  refreshSessionMessages,
  resolveFinalAssistantText,
} from "./delivery.js";
import { recoverKoishiTurnIfNeeded } from "./recovery.js";
import {
  buildPromptText,
  restorePromptParts,
  sendOutboxPayload,
  sendTyping,
} from "./transport.js";

export {
  normalizeKoishiIdleToolProgressConfig,
  summarizeKoishiToolCall,
  type KoishiIdleToolProgressConfig,
} from "./progress.js";

const INTERIM_PREFIX = "··· ";
const INTERIM_MIN_INTERVAL_MS = 1500;
const KOISHI_WORKING_PROGRESS_TEXT = "Working";

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
  liveTurn: {
    promise: Promise<any>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  } | null = null;
  interimText = "";
  interimSentText = "";
  interimSentAt = 0;
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
      this.handleClientEvent(event);
    });

    session.subscribe((event: any) => {
      this.handleSessionEvent(event);
    });

    const wantedSessionFile = this.getRecoverableSessionFile();
    if (wantedSessionFile) {
      await session.switchSession(wantedSessionFile);
      if (this.deliveryEnabled && !session.sessionManager.getSessionName?.())
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
            error instanceof Error
              ? error
              : new Error(String(error || "koishi_turn_failed")),
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
      now - this.interimSentAt <
        (options.minIntervalMs ?? INTERIM_MIN_INTERVAL_MS)
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
    const summary =
      safeString(this.lastToolCallSummary).trim() ||
      KOISHI_WORKING_PROGRESS_TEXT;
    const intervalMs = this.idleToolProgressIntervalMs();
    if (!this.hasActiveTurn()) {
      this.clearIdleToolProgressTimer();
      return;
    }
    const lastActivityAt = Math.max(
      this.lastVisibleProgressAt,
      this.lastIdleToolProgressAt,
    );
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
    await refreshSessionMessages(this);
  }
  private collectFinalAssistantText() {
    return collectFinalAssistantText(this);
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
    return buildAssistantDelivery(this as any, input);
  }
  private async commitPendingDelivery(clearProcessing = false) {
    await commitPendingDelivery(this as any, clearProcessing);
  }
  private markProcessedMessage(messageId?: string) {
    markProcessedMessage(this as any, messageId);
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
      this.failLiveTurn(
        error instanceof Error
          ? error
          : new Error(String(error || "koishi_turn_failed")),
      );
      throw error;
    }
    const completion = await liveTurn.promise;
    this.latestAssistantText = await resolveFinalAssistantText(
      this as any,
      completion,
    );
    this.state.piSessionFile =
      safeString(
        completion?.sessionFile ||
          this.session.sessionManager.getSessionFile?.() ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined;
    if (safeString(this.latestAssistantText || "").trim()) {
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
    } else {
      this.logger.warn(
        `koishi turn completed without visible final text chatKey=${this.chatKey}`,
      );
      delete this.state.processing;
      this.saveState();
      this.markProcessedMessage(input.incomingMessageId);
    }
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
    await recoverKoishiTurnIfNeeded(this as any);
  }
}

export function loadKoishiSettings(settingsPath: string) {
  const settings: any = readJsonFile(settingsPath, {}) || {};
  if (settings.enableSkillCommands == null) settings.enableSkillCommands = true;
  return settings;
}
