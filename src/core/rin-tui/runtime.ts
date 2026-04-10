import type {
  AgentEvent,
  AgentMessage,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";

import {
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { isSessionScopedCommand } from "../rin-lib/rpc.js";
import { RinDaemonFrontendClient } from "./rpc-client.js";
import { handleRpcSessionEvent } from "./events.js";
import { loadRpcLocalExtensions } from "./extensions.js";
import {
  setRpcAutoCompaction,
  cycleRpcModel,
  cycleRpcThinkingLevel,
  getPersistentSettingsManager,
  persistRpcSettingsMutation,
  setRpcFollowUpMode,
  setRpcModel,
  setRpcSteeringMode,
  setRpcThinkingLevel,
} from "./model-settings.js";
import {
  queueOfflineOperation,
  emitConnectionLost,
  type PendingRpcOperation,
} from "./reconnect.js";
import { createModelRegistry } from "./rpc-model-registry.js";
import {
  computeAvailableThinkingLevels,
  extractText,
  getLastAssistantText,
} from "./session-helpers.js";
import {
  computeSessionStats,
  getContextUsage,
  reconcilePendingQueues,
} from "./stats.js";
import {
  applyRpcMessages,
  applyRpcSessionState,
  applyRpcSessionTree,
  getSessionBranch,
} from "./state-utils.js";

type RpcExtensionBindings = {
  uiContext?: any;
  commandContextActions?: any;
  shutdownHandler?: () => void;
  onError?: (error: any) => void;
};

const REFRESH_MESSAGES = { messages: true } as const;
const REFRESH_MODELS = { models: true } as const;
const REFRESH_SESSION = { session: true } as const;
const REFRESH_MESSAGES_AND_SESSION = { messages: true, session: true } as const;
const REFRESH_ALL = { messages: true, models: true, session: true } as const;

class RemoteAgent {
  constructor(private client: RinDaemonFrontendClient) {}

  abort() {
    void this.client.abort().catch(() => {});
  }

  waitForIdle(timeout = 60000) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("rin_wait_for_idle_timeout"));
      }, timeout);
      const unsubscribe = this.client.subscribe((event) => {
        if (event.type !== "ui") return;
        if ((event.payload as any)?.type !== "agent_end") return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
  }

  async setTransport(_transport: string) {}
}

type RefreshFlags = { messages?: boolean; models?: boolean; session?: boolean };

function getRuntimeProfile() {
  return resolveRuntimeProfile();
}

function getRuntimeSessionDirForProfile(profile: {
  cwd: string;
  agentDir: string;
}) {
  return getRuntimeSessionDir(profile.cwd, profile.agentDir);
}

export class RpcInteractiveSession {
  public agent: RemoteAgent;
  public settingsManager: any;
  public modelRegistry: any;
  public resourceLoader: any;
  public sessionManager: any;

  public scopedModels: any[] = [];
  public promptTemplates: any[] = [];
  public extensionRunner: any = undefined;
  public model: any = null;
  public thinkingLevel: ThinkingLevel = "medium";
  public steeringMode: "all" | "one-at-a-time" = "all";
  public followUpMode: "all" | "one-at-a-time" = "one-at-a-time";
  public systemPrompt = "";
  public isStreaming = false;
  public isCompacting = false;
  public isBashRunning = false;
  public retryAttempt = 0;
  public pendingMessageCount = 0;
  public autoCompactionEnabled = false;
  public messages: AgentMessage[] = [];
  public state: any = {
    messages: this.messages,
    model: null,
    thinkingLevel: this.thinkingLevel,
  };

  private sessionId = "";
  private sessionFile?: string;
  private sessionName?: string;
  private leafId: string | null = null;
  private entries: any[] = [];
  private tree: any[] = [];
  private entryById = new Map<string, any>();
  private labelsById = new Map<string, string | undefined>();
  private lastSessionStats: any = undefined;
  private steeringMessages: string[] = [];
  private followUpMessages: string[] = [];
  private listeners = new Set<(event: AgentEvent) => void>();
  private unsubscribeClient?: () => void;
  private extensionBindings: RpcExtensionBindings = {};
  private additionalExtensionPaths: string[];
  private reconnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private queuedOfflineOps: PendingRpcOperation[] = [];
  private activeTurn: PendingRpcOperation | null = null;
  private daemonUnavailable = false;
  private disposed = false;
  private pendingRefreshFlags: RefreshFlags = {};
  private refreshLoopPromise: Promise<void> | null = null;
  private restorePromise: Promise<void> | null = null;
  private restoreResumeSent = false;

  constructor(
    public client: RinDaemonFrontendClient,
    additionalExtensionPaths: string[] = [],
  ) {
    this.additionalExtensionPaths = [...additionalExtensionPaths];
    const proto = Object.getPrototypeOf(this);
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      (this as any)[name] = descriptor.value.bind(this);
    }
    this.agent = new RemoteAgent(client);
    this.settingsManager = undefined;
    this.modelRegistry = createModelRegistry(client);
    this.resourceLoader = {
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getExtensions: () => ({ extensions: [], errors: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getPathMetadata: () => new Map(),
    };
    this.sessionManager = {
      getSessionFile: () => this.sessionFile,
      getSessionId: () => this.sessionId,
      getHeader: () => null,
      getEntry: (id: string) => this.entryById.get(id),
      getLabel: (id: string) => this.labelsById.get(id),
      getBranch: (fromId?: string) => this.getBranch(fromId),
      buildSessionContext: () => ({
        messages: this.messages,
        thinkingLevel: this.thinkingLevel,
        model: this.model
          ? { provider: this.model.provider, modelId: this.model.id }
          : null,
      }),
      getEntries: () => [...this.entries],
      getSessionName: () => this.sessionName,
      getTree: () => [...this.tree],
      getLeafId: () => this.leafId,
      appendLabelChange: (entryId: string, label: string | undefined) =>
        void this.setEntryLabel(entryId, label).catch(() => {}),
      getCwd: () => getRuntimeProfile().cwd,
      getSessionDir: () => getRuntimeSessionDirForProfile(getRuntimeProfile()),
      appendSessionInfo: (name: string) =>
        void this.setSessionName(name).catch(() => {}),
    };
  }

  async connect() {
    this.disposed = false;
    this.settingsManager = await getPersistentSettingsManager();
    this.autoCompactionEnabled = Boolean(
      this.settingsManager.getCompactionEnabled?.(),
    );
    await this.client.connect();
    this.unsubscribeClient?.();
    this.unsubscribeClient = this.client.subscribe((event) => {
      if (event.type === "ui" && event.name === "connection_lost") {
        this.handleConnectionLost();
        return;
      }
      if (event.type === "ui" && event.name === "connection_restored") {
        void this.handleConnectionRestored().catch(() => {});
        return;
      }
      if (event.type !== "ui") return;
      const payload: any = event.payload;
      if (!payload || payload.type === "response") return;
      if (payload.type === "oauth_login_event") {
        this.modelRegistry.authStorage.handleEvent(payload);
        return;
      }
      this.handleRpcEvent(payload);
    });
    await this.ensureRemoteSession();
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    await this.modelRegistry.sync().catch(() => {});
  }

  async disconnect() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.unsubscribeClient?.();
    this.unsubscribeClient = undefined;
    await this.client.disconnect();
  }

  subscribe(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(
    message: string,
    options?: {
      streamingBehavior?: "steer" | "followUp";
      images?: any[];
      source?: string;
      requestTag?: string;
    },
  ) {
    if (options?.streamingBehavior === "steer")
      return await this.interruptPrompt(message, options.images, {
        source: options?.source,
        requestTag: options?.requestTag,
      });
    if (options?.streamingBehavior === "followUp")
      return await this.followUp(message, options.images, {
        source: options?.source,
        requestTag: options?.requestTag,
      });
    await this.sendOrQueue({
      mode: "prompt",
      message,
      images: options?.images,
      source: options?.source,
      requestTag: options?.requestTag,
    });
  }

  async interruptPrompt(
    message: string,
    images?: any[],
    options?: { source?: string; requestTag?: string },
  ) {
    await this.sendOrQueue({
      mode: "interrupt_prompt",
      message,
      images,
      source: options?.source,
      requestTag: options?.requestTag,
    });
  }

  async resumeInterruptedTurn(options?: {
    source?: string;
    requestTag?: string;
  }) {
    await this.ensureRemoteSession();
    await this.call("resume_interrupted_turn", {
      source: options?.source,
      requestTag: options?.requestTag,
    });
  }

  async steer(
    message: string,
    images?: any[],
    options?: { source?: string; requestTag?: string },
  ) {
    this.enqueuePending("steeringMessages", message);
    await this.sendOrQueue({
      mode: "steer",
      message,
      images,
      source: options?.source,
      requestTag: options?.requestTag,
    });
  }

  async followUp(
    message: string,
    images?: any[],
    options?: { source?: string; requestTag?: string },
  ) {
    this.enqueuePending("followUpMessages", message);
    await this.sendOrQueue({
      mode: "follow_up",
      message,
      images,
      source: options?.source,
      requestTag: options?.requestTag,
    });
  }

  clearQueue() {
    const queued = {
      steering: [...this.steeringMessages],
      followUp: [...this.followUpMessages],
    };
    this.steeringMessages = [];
    this.followUpMessages = [];
    this.syncPendingCount();
    return queued;
  }

  getSteeringMessages() {
    return [...this.steeringMessages];
  }
  getFollowUpMessages() {
    return [...this.followUpMessages];
  }
  async abort() {
    await this.client.abort();
  }

  async newSession(_options?: { parentSession?: string }) {
    const data = await this.call("new_session");
    await this.refreshState(REFRESH_ALL);
    return !Boolean(data?.cancelled);
  }

  async switchSession(sessionPath: string, _cwdOverride?: string) {
    const data = await this.call("switch_session", { sessionPath });
    await this.refreshState(REFRESH_ALL);
    return !Boolean(data?.cancelled);
  }

  async renameSession(sessionPath: string, name: string) {
    await this.call("rename_session", { sessionPath, name });
    if (this.sessionFile === sessionPath)
      await this.refreshState(REFRESH_SESSION);
  }

  async listSessions(
    scope: "cwd" | "all" = "cwd",
    _onProgress?: (loaded: number, total: number) => void,
  ) {
    const data = await this.call("list_sessions", { scope });
    return Array.isArray(data?.sessions) ? data.sessions : [];
  }

  async setModel(model: any) {
    await setRpcModel(this as any, model, () =>
      this.refreshState(REFRESH_MODELS),
    );
  }

  persistSettingsMutation(mutate: (settings: any) => void | Promise<void>) {
    return persistRpcSettingsMutation(mutate);
  }

  setScopedModels(
    scopedModels: Array<{ model: any; thinkingLevel?: ThinkingLevel }>,
  ) {
    this.scopedModels = [...scopedModels];
  }

  async cycleModel(direction?: "forward" | "backward") {
    return await cycleRpcModel(
      this as any,
      direction,
      () => this.refreshState(REFRESH_MODELS),
    );
  }

  setThinkingLevel(level: ThinkingLevel) {
    setRpcThinkingLevel(this as any, level);
  }

  cycleThinkingLevel(): ThinkingLevel | undefined {
    return cycleRpcThinkingLevel(this as any);
  }

  getAvailableThinkingLevels() {
    return computeAvailableThinkingLevels(this.model);
  }

  setSteeringMode(mode: "all" | "one-at-a-time") {
    setRpcSteeringMode(this as any, mode);
  }

  setFollowUpMode(mode: "all" | "one-at-a-time") {
    setRpcFollowUpMode(this as any, mode);
  }

  async compact(customInstructions?: string) {
    const data = await this.call("compact", { customInstructions });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return data;
  }

  abortCompaction() {
    void this.client.abort().catch(() => {});
  }
  abortBranchSummary() {}

  setAutoCompactionEnabled(enabled: boolean) {
    setRpcAutoCompaction(this as any, enabled);
  }

  async executeBash(command: string) {
    this.isBashRunning = true;
    try {
      const data = await this.call("bash", { command });
      await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
      return data;
    } finally {
      this.isBashRunning = false;
    }
  }

  async ensureSessionReady() {
    await this.ensureRemoteSession();
    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      sessionName: this.sessionName,
    };
  }

  async runCommand(commandLine: string) {
    const trimmed = String(commandLine || "").trim();
    if (trimmed === "/abort") {
      await this.abort();
      return { handled: true, text: "Aborted current operation." };
    }
    if (trimmed === "/new") {
      const completed = await this.newSession();
      return {
        handled: true,
        text: completed ? "Started a new session." : "Session switch cancelled.",
      };
    }
    if (trimmed.startsWith("/resume ")) {
      const wanted = trimmed.slice("/resume ".length).trim();
      if (wanted) {
        const sessions = await this.listSessions("cwd");
        const match = sessions.find(
          (item: any) => String(item?.id || "") === wanted,
        );
        if (!match)
          return { handled: true, text: `Session not found: ${wanted}` };
        const completed = await this.switchSession(String(match.path || ""));
        return {
          handled: true,
          text: completed
            ? `Resumed session: ${String(match.id || "")}`
            : "Session switch cancelled.",
        };
      }
    }
    await this.ensureRemoteSession();
    const data = await this.call("run_command", { commandLine });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return data;
  }

  async terminateSession() {
    if (!this.sessionFile && !this.sessionId) return;
    await this.call("terminate_session");
  }

  async detachSession() {
    await this.call("detach_session");
    await this.refreshState(REFRESH_ALL).catch(() => {});
  }

  recordBashResult(
    _command: string,
    _result: any,
    _options?: { excludeFromContext?: boolean },
  ) {}

  async abortBash() {
    await this.call("abort_bash");
    this.isBashRunning = false;
  }

  abortRetry() {
    void this.call("abort_retry").catch(() => {});
  }
  get isRetrying() {
    return this.retryAttempt > 0;
  }
  get autoRetryEnabled() {
    return false;
  }
  setAutoRetryEnabled(_enabled: boolean) {}

  setSessionName(name: string) {
    this.sessionName = name;
    return this.call("set_session_name", { name }).then(async () => {
      await this.refreshState(REFRESH_SESSION);
    });
  }

  async setEntryLabel(entryId: string, label: string | undefined) {
    await this.call("set_entry_label", { entryId, label });
    await this.refreshState(REFRESH_SESSION);
  }

  async fork(entryId: string) {
    const data = await this.call("fork", { entryId });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return {
      cancelled: Boolean(data?.cancelled),
      selectedText: String(data?.text || ""),
    };
  }

  async navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ) {
    const data = await this.call("navigate_tree", {
      targetId,
      summarize: options?.summarize,
      customInstructions: options?.customInstructions,
      replaceInstructions: options?.replaceInstructions,
      label: options?.label,
    });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return {
      cancelled: Boolean(data?.cancelled),
      aborted: Boolean(data?.aborted),
      editorText: typeof data?.editorText === "string" ? data.editorText : "",
      summaryEntry: data?.summaryEntry,
    };
  }

  getUserMessagesForForking() {
    return this.entries
      .filter(
        (entry: any) =>
          entry?.type === "message" && entry.message?.role === "user",
      )
      .map((entry: any) => ({
        entryId: String(entry.id),
        text: extractText(entry.message?.content),
      }))
      .filter((entry: any) => entry.text);
  }

  getSessionStats() {
    this.lastSessionStats = this.computeSessionStats();
    return this.lastSessionStats;
  }

  getContextUsage() {
    return getContextUsage(this.model, this.messages, this.getBranch());
  }

  async exportToHtml(outputPath?: string) {
    const data = await this.call("export_html", { outputPath });
    return String(data?.path || "");
  }

  async exportToJsonl(outputPath?: string) {
    const data = await this.call("export_jsonl", { outputPath });
    return String(data?.path || "");
  }

  async importFromJsonl(inputPath: string, _cwdOverride?: string) {
    const data = await this.call("import_jsonl", { inputPath });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return !Boolean(data?.cancelled);
  }

  getLastAssistantText() {
    return getLastAssistantText(this.messages);
  }

  getToolDefinition(toolName: string) {
    return this.extensionRunner?.getToolDefinition?.(toolName);
  }

  async reload() {
    await this.modelRegistry.sync();
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    if (this.extensionRunner) {
      await this.loadLocalExtensions(true);
    }
  }

  async bindExtensions(bindings: RpcExtensionBindings = {}) {
    this.extensionBindings = {
      ...this.extensionBindings,
      ...bindings,
    };
    await this.loadLocalExtensions(false);
  }

  private async loadLocalExtensions(forceReload: boolean) {
    await loadRpcLocalExtensions(this as any, forceReload, getRuntimeProfile());
  }

  private handleRpcEvent(payload: any) {
    if (payload?.type === "extension_ui_request") return;
    void handleRpcSessionEvent(
      this as any,
      payload,
      () => this.queueRefreshState(REFRESH_MESSAGES),
      () => this.queueRefreshState(REFRESH_MESSAGES_AND_SESSION),
    );
  }

  private emitEvent(event: AgentEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private queueOfflineOperation(operation: PendingRpcOperation) {
    queueOfflineOperation(this as any, operation);
  }

  private async sendOrQueue(operation: PendingRpcOperation) {
    if (!this.client.isConnected()) {
      this.queueOfflineOperation(operation);
      return;
    }

    const sendOperation = async () => {
      await this.ensureRemoteSession();
      this.isStreaming = true;
      this.activeTurn = operation;
      this.restoreResumeSent = false;
      await this.call(operation.mode, {
        message: operation.message,
        images: operation.images,
        source: operation.source,
        requestTag: operation.requestTag,
      });
    };

    try {
      await sendOperation();
    } catch (error: any) {
      const message = String(error?.message || error || "");
      if (/rin_tui_not_connected|rin_disconnected/.test(message)) {
        this.queueOfflineOperation(operation);
        return;
      }
      if (/rin_no_attached_session/.test(message) && this.sessionFile) {
        await this.call("switch_session", { sessionPath: this.sessionFile });
        await this.refreshState(REFRESH_ALL);
        await sendOperation();
        return;
      }
      throw error;
    }
  }

  private handleConnectionLost() {
    this.restoreResumeSent = false;
    this.daemonUnavailable = true;
    emitConnectionLost(this as any);
  }

  private ensureReconnectLoop() {
    if (this.reconnecting || this.disposed) return;
    this.reconnecting = true;
    const tick = async () => {
      if (this.disposed) return;
      try {
        await this.client.connect();
      } catch {
        this.reconnectTimer = setTimeout(() => {
          void tick();
        }, 1000);
      }
    };
    void tick();
  }

  private async handleConnectionRestored() {
    if (this.disposed) return;
    if (this.restorePromise) return await this.restorePromise;
    this.restorePromise = (async () => {
      this.reconnecting = false;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.emitEvent({
        type: "rin_status",
        phase: "update",
        message: "Resuming session...",
        statusText: "Daemon connection restored.",
      } as any);
      try {
        if (this.sessionFile) {
          await this.call("switch_session", { sessionPath: this.sessionFile });
        } else if (this.sessionId) {
          await this.call("attach_session", { sessionId: this.sessionId });
        } else {
          await this.ensureRemoteSession();
        }
        await this.refreshState(REFRESH_MESSAGES_AND_SESSION);

        if (
          this.activeTurn &&
          !this.isStreaming &&
          !this.isCompacting &&
          !this.restoreResumeSent &&
          this.shouldRetryInterruptedTurn()
        ) {
          this.restoreResumeSent = true;
          await this.resumeInterruptedTurn({
            source: this.activeTurn.source || "daemon-reconnect",
            requestTag: this.activeTurn.requestTag,
          });
          await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
        }

        const queued = [...this.queuedOfflineOps];
        this.queuedOfflineOps = [];
        for (const operation of queued) {
          await this.sendOrQueue(operation);
        }

        if (!this.isStreaming && !this.isCompacting) {
          this.activeTurn = null;
        }
      } finally {
        this.daemonUnavailable = false;
        if (!this.isStreaming && !this.isCompacting) {
          this.emitEvent({ type: "rin_status", phase: "end" } as any);
        }
      }
    })().finally(() => {
      this.restorePromise = null;
    });
    return await this.restorePromise;
  }

  private enqueuePending(
    queue: "steeringMessages" | "followUpMessages",
    message: string,
  ) {
    this[queue].push(message);
    this.syncPendingCount();
  }

  private async ensureRemoteSession() {
    if (this.sessionFile || this.sessionId) return;
    const data = await this.call("new_session");
    if (data && data.cancelled) throw new Error("rin_new_session_cancelled");
    await this.refreshState(REFRESH_ALL);
  }

  private buildSessionCommandPayload(
    type: string,
    payload: Record<string, unknown>,
  ) {
    if (!isSessionScopedCommand(type)) return payload;
    if (type === "switch_session" || type === "attach_session") return payload;
    if (type === "new_session" || type === "detach_session") return payload;
    if (payload.sessionFile || payload.sessionId) return payload;
    if (this.sessionFile) return { ...payload, sessionFile: this.sessionFile };
    if (this.sessionId) return { ...payload, sessionId: this.sessionId };
    return payload;
  }

  private async call(type: string, payload: Record<string, unknown> = {}) {
    const response: any = await this.client.send({
      type,
      ...this.buildSessionCommandPayload(type, payload),
    });
    if (!response || response.success !== true) {
      throw new Error(String(response?.error || "rin_request_failed"));
    }
    return response.data;
  }

  private async refreshState(flags: RefreshFlags = {}) {
    this.applyState(await this.call("get_state"));
    await Promise.all([
      flags.models ? this.modelRegistry.sync() : Promise.resolve(),
      flags.messages ? this.refreshMessages() : Promise.resolve(),
      flags.session ? this.refreshSessionData() : Promise.resolve(),
    ]);
    this.reconcilePendingQueues(this.pendingMessageCount);
    this.lastSessionStats = this.computeSessionStats();
  }

  private queueRefreshState(flags: RefreshFlags = {}) {
    this.pendingRefreshFlags = {
      messages: this.pendingRefreshFlags.messages || flags.messages,
      models: this.pendingRefreshFlags.models || flags.models,
      session: this.pendingRefreshFlags.session || flags.session,
    };
    if (this.refreshLoopPromise) return this.refreshLoopPromise;
    this.refreshLoopPromise = (async () => {
      while (
        this.pendingRefreshFlags.messages ||
        this.pendingRefreshFlags.models ||
        this.pendingRefreshFlags.session
      ) {
        const next = this.pendingRefreshFlags;
        this.pendingRefreshFlags = {};
        try {
          await this.refreshState(next);
        } catch {}
      }
    })().finally(() => {
      this.refreshLoopPromise = null;
    });
    return this.refreshLoopPromise;
  }

  private applyState(state: any) {
    applyRpcSessionState(this as any, state);
  }

  private async refreshMessages() {
    const data = await this.call("get_messages");
    applyRpcMessages(this as any, data);
  }

  private async refreshSessionData() {
    const [entriesData, treeData] = await Promise.all([
      this.call("get_session_entries"),
      this.call("get_session_tree"),
    ]);
    applyRpcSessionTree(this as any, entriesData, treeData);
  }

  private getBranch(fromId?: string) {
    return getSessionBranch(this.entryById, this.leafId, fromId);
  }

  private shouldRetryInterruptedTurn() {
    const lastMessage = Array.isArray(this.messages)
      ? this.messages[this.messages.length - 1]
      : null;
    if (!lastMessage || lastMessage.role !== "assistant") return false;
    const toolCalls = Array.isArray(lastMessage.content)
      ? lastMessage.content.filter((item: any) => item?.type === "toolCall")
      : [];
    return toolCalls.length > 0;
  }

  private computeSessionStats() {
    return computeSessionStats(
      this.model,
      this.sessionFile,
      this.sessionId,
      this.entries,
      this.getContextUsage(),
    );
  }

  private reconcilePendingQueues(targetCount: number) {
    reconcilePendingQueues(
      this.steeringMessages,
      this.followUpMessages,
      targetCount,
    );
  }

  private syncPendingCount() {
    this.pendingMessageCount =
      this.steeringMessages.length + this.followUpMessages.length;
  }
}
