import path from "node:path";

import type { TurnResult, TurnResultMessage } from "../session/turn-result.js";
import { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";
import { RpcInteractiveSession } from "../rin-tui/runtime.js";
import { chatStateDir, chatStatePath } from "../chat-bridge/session-binding.js";
import { readJsonFile, writeJsonFile } from "./support.js";
import {
  KoishiChatState,
  SavedAttachment,
  extractTextFromContent,
  markProcessedKoishiMessage,
  persistImageParts,
  safeString,
} from "./chat-helpers.js";
import { appendKoishiChatLog } from "./chat-log.js";
import {
  buildPromptText,
  recordDeliveredAssistantMessages,
  restorePromptParts,
  sendGenericFile,
  sendImageFile,
  sendText,
  sendTyping,
} from "./transport.js";

const INTERIM_PREFIX = "··· ";
const TYPING_INTERVAL_MS = 4000;
const INTERIM_MIN_INTERVAL_MS = 1500;
const SESSION_IDLE_DETACH_MS = 60_000;

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
  idleDetachTimer: NodeJS.Timeout | null = null;
  pendingCompletedAssistantText = "";
  logger: any;
  h: any;

  constructor(
    app: any,
    dataDir: string,
    chatKey: string,
    deps: { logger: any; h: any },
  ) {
    this.app = app;
    this.chatKey = chatKey;
    this.dataDir = dataDir;
    this.agentDir = path.resolve(dataDir, "..");
    this.statePath = chatStatePath(dataDir, chatKey);
    this.state = readJsonFile<KoishiChatState>(this.statePath, { chatKey });
    this.logger = deps.logger;
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
          this.startTyping();
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
          if (finalText) this.pendingCompletedAssistantText = finalText;
          break;
        }
        case "tool_execution_start":
        case "tool_execution_end":
        case "compaction_start":
        case "compaction_end":
          if (this.pendingCompletedAssistantText)
            void this.flushInterim().catch(() => {});
          break;
        case "agent_end":
          this.pendingCompletedAssistantText = "";
          this.stopTyping();
          break;
      }
    });

    const wantedSessionFile = safeString(this.state.piSessionFile || "").trim();
    if (wantedSessionFile)
      await session.switchSession(wantedSessionFile).catch(() => {});
    if (!session.sessionManager.getSessionName?.())
      await session.setSessionName(this.chatKey);
  }

  dispose() {
    this.stopTyping();
    this.clearIdleDetachTimer();
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
  private clearIdleDetachTimer() {
    if (!this.idleDetachTimer) return;
    clearTimeout(this.idleDetachTimer);
    this.idleDetachTimer = null;
  }
  private scheduleIdleDetach() {
    this.clearIdleDetachTimer();
    this.idleDetachTimer = setTimeout(() => {
      void this.detachIdleSession().catch(() => {});
    }, SESSION_IDLE_DETACH_MS);
  }
  private async detachIdleSession() {
    this.clearIdleDetachTimer();
    if (!this.session || this.turnWaiters.size > 0) return;
    const currentSessionFile = safeString(
      this.session.sessionManager.getSessionFile?.() ||
        this.state.piSessionFile ||
        "",
    ).trim();
    if (currentSessionFile) this.state.piSessionFile = currentSessionFile;
    await this.session.detachSession?.().catch(() => {});
    this.saveState();
  }
  private startTyping() {
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
  private async flushInterim(force = false) {
    const text = safeString(this.pendingCompletedAssistantText || "").trim();
    if (!text) return;
    const now = Date.now();
    if (!force && text === this.interimSentText) return;
    if (!force && now - this.interimSentAt < INTERIM_MIN_INTERVAL_MS) return;
    this.pendingCompletedAssistantText = "";
    this.interimSentText = text;
    this.interimSentAt = now;
    const replyToMessageId = safeString(
      this.state.processing?.replyToMessageId || "",
    ).trim();
    await sendText(
      this.app,
      this.chatKey,
      `${INTERIM_PREFIX}${text}`,
      this.h,
      replyToMessageId,
    )
      .then((deliveryResult) => {
        recordDeliveredAssistantMessages(this.agentDir, {
          chatKey: this.chatKey,
          deliveryResult,
          text: `${INTERIM_PREFIX}${text}`,
          rawContent: `${INTERIM_PREFIX}${text}`,
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
  private normalizeTurnResult(payload: any): TurnResult {
    const result = payload?.result;
    if (!result || !Array.isArray(result.messages)) {
      throw new Error("koishi_turn_result_missing");
    }
    return result as TurnResult;
  }
  private async deliverTurnResult(result: TurnResult, replyToMessageId = "") {
    const sessionId = this.currentSessionId() || undefined;
    const sessionFile =
      safeString(
        this.session?.sessionManager?.getSessionFile?.() ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined;

    for (const message of result.messages) {
      const item = (message || {}) as TurnResultMessage;
      if (item.type === "text") {
        const text = safeString(item.text).trim();
        if (!text) continue;
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
          sessionId,
          sessionFile,
        });
        continue;
      }

      if (item.type === "image") {
        const images = await persistImageParts(
          chatStateDir(this.dataDir, this.chatKey),
          [
            {
              data: safeString((item as any).data || ""),
              mimeType:
                safeString((item as any).mimeType || "").trim() || "image/png",
            },
          ],
          `${Date.now()}-assistant`,
        );
        for (const image of images) {
          const deliveryResult = await sendImageFile(
            this.app,
            this.chatKey,
            image.path,
            this.h,
            image.mimeType || "image/png",
            replyToMessageId,
          );
          recordDeliveredAssistantMessages(this.agentDir, {
            chatKey: this.chatKey,
            deliveryResult,
            text: `[image] ${image.name}`,
            rawContent: `[image] ${image.path}`,
            replyToMessageId: replyToMessageId || undefined,
            sessionId,
            sessionFile,
          });
        }
        continue;
      }

      if (item.type === "file") {
        const filePath = safeString((item as any).path || "").trim();
        if (!filePath) continue;
        const fileName =
          safeString((item as any).name || "").trim() ||
          path.basename(filePath);
        const deliveryResult = await sendGenericFile(
          this.app,
          this.chatKey,
          filePath,
          this.h,
          fileName,
          replyToMessageId,
        );
        recordDeliveredAssistantMessages(this.agentDir, {
          chatKey: this.chatKey,
          deliveryResult,
          text: `[file] ${fileName}`,
          rawContent: `[file] ${filePath}`,
          replyToMessageId: replyToMessageId || undefined,
          sessionId,
          sessionFile,
        });
      }
    }
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
    this.clearIdleDetachTimer();
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
    if (!this.session.sessionManager.getSessionName?.())
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
    this.clearIdleDetachTimer();
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
    if (!this.session.sessionManager.getSessionName?.())
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
    if (!this.session.sessionManager.getSessionName?.())
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
    this.scheduleIdleDetach();
    return data;
  }
  async runTurn(
    input: {
      text: string;
      attachments: SavedAttachment[];
      replyToMessageId?: string;
      incomingMessageId?: string;
    },
    mode: "prompt" | "interrupt_prompt" = "prompt",
  ) {
    await this.connect();
    if (!this.session) throw new Error("koishi_session_not_connected");
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
    const completion = this.waitForTurn(tag);
    this.startTyping();
    await this.session.prompt(text, {
      images,
      requestTag: tag,
      source: "koishi-bridge",
      streamingBehavior: mode === "interrupt_prompt" ? "steer" : undefined,
    });
    const payload = await completion;
    if (this.activeTag !== tag) return;
    const result = this.normalizeTurnResult(payload);
    const replyToMessageId = safeString(
      this.state.processing?.replyToMessageId || input.replyToMessageId || "",
    ).trim();
    this.state.piSessionFile =
      safeString(
        payload?.sessionFile ||
          this.session.sessionManager.getSessionFile?.() ||
          this.state.piSessionFile ||
          "",
      ).trim() || undefined;
    delete this.state.processing;
    this.saveState();
    this.markProcessedMessage(input.incomingMessageId);
    await this.deliverTurnResult(result, replyToMessageId);
    this.scheduleIdleDetach();
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
      const completion = this.waitForTurn(tag);
      this.startTyping();
      await this.session.resumeInterruptedTurn({
        source: "koishi-bridge",
        requestTag: tag,
      });
      const payload = await completion;
      if (this.activeTag !== tag) return;
      const result = this.normalizeTurnResult(payload);
      this.state.piSessionFile =
        safeString(
          payload?.sessionFile ||
            this.session.sessionManager.getSessionFile?.() ||
            this.state.piSessionFile ||
            "",
        ).trim() || undefined;
      delete this.state.processing;
      this.saveState();
      await this.deliverTurnResult(
        result,
        safeString(pending.replyToMessageId || "").trim(),
      );
      this.scheduleIdleDetach();
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
