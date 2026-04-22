import { resolveTurnCompletion } from "../session/turn-result.js";
import { normalizeSessionRef } from "../session/ref.js";
import { extractMessageText } from "../message-content.js";
import { safeString } from "../text-utils.js";
import type { RpcFrontendClient } from "./frontend-surface.js";
import { RinDaemonFrontendClient } from "./rpc-client.js";
import { RpcInteractiveSession } from "./runtime.js";

type FrontendPhase = "idle" | "connecting" | "starting" | "sending" | "working";

type DriverTurnResult = {
  finalText?: string;
  result?: any;
  steered?: boolean;
  sessionId?: string;
  sessionFile?: string;
};

export type ChatFrontendDriverEvent =
  | { type: "frontend_status"; phase: FrontendPhase }
  | { type: "turn_accepted" }
  | { type: "assistant_interim"; text: string };

function isAgentAlreadyProcessingError(error: unknown) {
  return safeString((error as any)?.message || error).includes(
    "Agent is already processing.",
  );
}

function isQueuedOperationArray(
  value: unknown,
): value is Array<{ requestTag?: string }> {
  return Array.isArray(value);
}

export class ChatFrontendDriver {
  private readonly clientFactory: () => RpcFrontendClient;
  client: RpcFrontendClient | null = null;
  session: RpcInteractiveSession | any = null;
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
  frontendPhase: FrontendPhase = "idle";
  listeners = new Set<(event: ChatFrontendDriverEvent) => void>();

  constructor(options: { clientFactory?: () => RpcFrontendClient } = {}) {
    this.clientFactory =
      options.clientFactory || (() => new RinDaemonFrontendClient());
  }

  subscribe(listener: (event: ChatFrontendDriverEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChatFrontendDriverEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  async connect(options: { restoreSessionFile?: string } = {}) {
    if (this.session) return;
    const client = this.clientFactory();
    const session = new RpcInteractiveSession(client);
    await session.connect();
    this.client = client;
    this.session = session;

    session.subscribe((event: any) => {
      void this.handleSessionEvent(event).catch(() => {});
    });

    const wantedSessionFile = safeString(
      options.restoreSessionFile || "",
    ).trim();
    if (wantedSessionFile) {
      await session.switchSession(wantedSessionFile);
    }
  }

  dispose() {
    this.failLiveTurn(new Error("chat_controller_disposed"));
    this.resetTurnTextTracking();
    this.frontendPhase = "idle";
    const session = this.session;
    this.client = null;
    this.session = null;
    if (session?.disconnect) {
      void session.disconnect().catch(() => {});
    }
  }

  currentSessionId() {
    return safeString(
      this.session?.sessionManager?.getSessionId?.() || "",
    ).trim();
  }

  currentSessionFile() {
    return safeString(
      this.session?.sessionManager?.getSessionFile?.() || "",
    ).trim();
  }

  private createTurnRequestTag() {
    return `chat_turn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
    liveTurn.promise.catch(() => {});
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

  private async flushPendingAssistantInterimBeforeFinal(finalText: string) {
    const pendingText = safeString(this.pendingCompletedAssistantText).trim();
    const nextFinalText = safeString(finalText).trim();
    if (!pendingText) return false;
    if (pendingText === nextFinalText) {
      this.pendingCompletedAssistantText = "";
      return false;
    }
    await this.queueInterimDelivery(async () => {
      await this.flushPendingAssistantInterim();
    });
    return true;
  }

  private async flushPendingAssistantInterim() {
    const text = safeString(this.pendingCompletedAssistantText).trim();
    this.pendingCompletedAssistantText = "";
    if (!text) return false;
    if (this.deliveredInterimTexts.has(text)) return false;
    this.deliveredInterimTexts.add(text);
    this.emit({ type: "assistant_interim", text });
    return true;
  }

  private promotePendingAssistantMessageToInterim() {
    if (!safeString(this.pendingCompletedAssistantText).trim()) return;
    void this.queueInterimDelivery(async () => {
      await this.flushPendingAssistantInterim();
    }).catch(() => {});
  }

  private async handleAssistantMessageEnd(message: any) {
    const text = safeString(
      extractMessageText(message?.content, {
        includeThinking: false,
        trim: true,
      }),
    ).trim();
    if (!text) return;
    if (safeString(this.pendingCompletedAssistantText).trim()) {
      await this.queueInterimDelivery(async () => {
        await this.flushPendingAssistantInterim();
      });
    }
    this.pendingCompletedAssistantText = text;
    this.latestAssistantText = text;
  }

  private consumeQueuedOfflineOperation(requestTag?: string) {
    const tag = safeString(requestTag || "").trim();
    if (!tag) return false;
    const queued = (this.session as any)?.queuedOfflineOps;
    if (!isQueuedOperationArray(queued)) return false;
    const index = queued.findIndex(
      (item) => safeString(item?.requestTag || "").trim() === tag,
    );
    if (index < 0) return false;
    queued.splice(index, 1);
    if (typeof (this.session as any)?.syncPendingCount === "function") {
      (this.session as any).syncPendingCount();
    }
    if (typeof (this.session as any)?.emitFrontendStatus === "function") {
      (this.session as any).emitFrontendStatus(true);
    }
    return true;
  }

  private throwIfQueuedOffline(requestTag?: string) {
    if (!this.consumeQueuedOfflineOperation(requestTag)) return;
    throw new Error("rin_disconnected:rpc_turn_queued_offline");
  }

  private async switchSessionIfNeeded(sessionFile?: string) {
    const wanted = safeString(sessionFile || "").trim();
    if (!wanted) return { changed: false };
    if (!this.session) throw new Error("chat_session_not_connected");
    const before = this.currentSessionFile();
    if (before !== wanted) await this.session.switchSession(wanted);
    return {
      changed: before !== wanted,
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile() || undefined,
    };
  }

  async resumeSessionFile(sessionFile: string) {
    await this.connect();
    return await this.switchSessionIfNeeded(sessionFile);
  }

  private async ensureSessionReady(restoreSessionFile = "") {
    if (!this.session) throw new Error("chat_session_not_connected");
    const current = this.currentSessionFile();
    const wanted = safeString(restoreSessionFile || "").trim();
    if (!current && wanted) {
      await this.switchSessionIfNeeded(wanted);
    }
    return await this.session.ensureSessionReady();
  }

  async runCommand(
    commandLine: string,
    options: {
      skipSessionRecovery?: boolean;
      restoreSessionFile?: string;
      sessionFile?: string;
    } = {},
  ) {
    const skipSessionRecovery = options.skipSessionRecovery === true;
    const restoreSessionFile = safeString(
      options.restoreSessionFile || "",
    ).trim();
    const sessionFile = safeString(options.sessionFile || "").trim();
    await this.connect({
      restoreSessionFile: skipSessionRecovery ? "" : restoreSessionFile,
    });
    if (!this.session) throw new Error("chat_session_not_connected");
    if (sessionFile) {
      await this.switchSessionIfNeeded(sessionFile);
    }
    const ready = !skipSessionRecovery
      ? await this.ensureSessionReady(sessionFile || restoreSessionFile)
      : undefined;
    const data: any = await this.session.runCommand(commandLine);
    return {
      ...data,
      sessionId:
        safeString(
          data?.sessionId || ready?.sessionId || this.currentSessionId(),
        ).trim() || undefined,
      sessionFile:
        safeString(
          data?.sessionFile || ready?.sessionFile || this.currentSessionFile(),
        ).trim() || undefined,
    };
  }

  async runTurn(input: {
    text: string;
    images?: any[];
    sessionFile?: string;
    restoreSessionFile?: string;
  }): Promise<DriverTurnResult> {
    const sessionFile = safeString(input.sessionFile || "").trim();
    const restoreSessionFile = safeString(
      input.restoreSessionFile || "",
    ).trim();
    await this.connect({ restoreSessionFile });
    if (!this.session) throw new Error("chat_session_not_connected");
    if (sessionFile) {
      await this.switchSessionIfNeeded(sessionFile);
    }
    const ready = await this.ensureSessionReady(
      sessionFile || restoreSessionFile,
    );
    const text = safeString(input.text).trim();
    const images = Array.isArray(input.images) ? input.images : [];

    if (this.session.isStreaming) {
      const requestTag = this.createTurnRequestTag();
      await this.session.prompt(text, {
        images,
        source: "chat-bridge",
        streamingBehavior: "steer",
        requestTag,
      });
      this.throwIfQueuedOffline(requestTag);
      return {
        steered: true,
        sessionId:
          safeString(ready?.sessionId || this.currentSessionId()).trim() ||
          undefined,
        sessionFile:
          safeString(ready?.sessionFile || this.currentSessionFile()).trim() ||
          undefined,
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
      this.throwIfQueuedOffline(requestTag);
    } catch (error: any) {
      if (isAgentAlreadyProcessingError(error)) {
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        const steerRequestTag = this.createTurnRequestTag();
        await this.session.prompt(text, {
          images,
          source: "chat-bridge",
          streamingBehavior: "steer",
          requestTag: steerRequestTag,
        });
        this.throwIfQueuedOffline(steerRequestTag);
        return {
          steered: true,
          sessionId:
            safeString(ready?.sessionId || this.currentSessionId()).trim() ||
            undefined,
          sessionFile:
            safeString(
              ready?.sessionFile || this.currentSessionFile(),
            ).trim() || undefined,
        };
      }
      this.failLiveTurn(
        error instanceof Error
          ? error
          : new Error(String(error || "chat_turn_failed")),
      );
      throw error;
    }

    const completion = await liveTurn.promise;
    const completionFinalText = safeString(
      (completion as any)?.finalText,
    ).trim();
    await this.flushPendingAssistantInterimBeforeFinal(completionFinalText);
    await this.waitForInterimDeliveries();
    const canonicalCompletion = resolveTurnCompletion({
      ...completion,
      messages: Array.isArray(this.session?.messages)
        ? this.session.messages
        : [],
    });
    const finalText =
      safeString((completion as any)?.finalText).trim() ||
      safeString(canonicalCompletion.finalText).trim();
    if (!finalText) {
      throw new Error("rpc_turn_final_output_missing");
    }
    this.latestAssistantText = finalText;
    return {
      finalText,
      result: canonicalCompletion.result,
      sessionId:
        safeString(completion?.sessionId || this.currentSessionId()).trim() ||
        undefined,
      sessionFile:
        safeString(
          completion?.sessionFile || this.currentSessionFile(),
        ).trim() || undefined,
    };
  }

  async handleClientEvent(event: any) {
    if (!event || typeof event !== "object") return;
    const payload = event.type === "ui" ? event.payload : event;
    await this.handleSessionEvent(payload);
  }

  private async handleSessionEvent(event: any) {
    if (!event || typeof event !== "object") return;
    if (event.type === "rpc_frontend_status") {
      this.frontendPhase =
        (safeString(event.phase).trim() as FrontendPhase) || "idle";
      this.emit({ type: "frontend_status", phase: this.frontendPhase });
      return;
    }
    if (event.type === "rpc_turn_event") {
      if (event.event === "start" || event.event === "heartbeat") {
        this.emit({ type: "turn_accepted" });
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
        this.emit({ type: "turn_accepted" });
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
        this.emit({ type: "turn_accepted" });
        this.promotePendingAssistantMessageToInterim();
        break;
    }
  }
}
