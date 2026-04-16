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
type PendingRpcOperation = {
  mode: "prompt" | "steer" | "follow_up";
  message: string;
  images?: any[];
  streamingBehavior?: "steer" | "followUp";
  source?: string;
  requestTag?: string;
};
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

type RpcFrontendPhase =
  | "idle"
  | "starting"
  | "sending"
  | "working"
  | "connecting";

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
  private reconnectPromise: Promise<void> | null = null;
  private queuedOfflineOps: PendingRpcOperation[] = [];
  private activeTurn: PendingRpcOperation | null = null;
  private rpcConnected = false;
  private remoteTurnRunning = false;
  private disposed = false;
  private pendingRefreshFlags: RefreshFlags = {};
  private refreshLoopPromise: Promise<void> | null = null;
  private restorePromise: Promise<void> | null = null;
  private waitForDaemonPromise: Promise<void> | null = null;
  private waitForDaemonHintTimer: NodeJS.Timeout | null = null;
  private startupPending = true;
  private sessionOperationPending = false;
  private recoveryPending = false;
  private lastFrontendPhase: RpcFrontendPhase | null = null;
  private nextRequestTagId = 0;

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
    this.startupPending = true;
    this.emitFrontendStatus(true);
    this.settingsManager = await getPersistentSettingsManager();
    this.autoCompactionEnabled = Boolean(
      this.settingsManager.getCompactionEnabled?.(),
    );
    this.unsubscribeClient?.();
    this.unsubscribeClient = this.client.subscribe((event) => {
      if (event.type === "ui" && event.name === "connection_lost") {
        this.handleConnectionLost();
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
    try {
      await this.client.connect();
      this.setRpcConnected(true);
      await this.refreshState(REFRESH_MESSAGES_AND_SESSION).catch(() => {});
      await this.modelRegistry.sync().catch(() => {});
    } catch {
      this.handleConnectionLost();
    } finally {
      this.startupPending = false;
      this.emitFrontendStatus(true);
    }
  }

  async disconnect() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearWaitingDaemonState();
    this.unsubscribeClient?.();
    this.unsubscribeClient = undefined;
    this.recoveryPending = false;
    this.setRpcConnected(false);
    await this.client.disconnect();
  }

  subscribe(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener);
    const current = this.getFrontendStatusEvent();
    if (current) {
      try {
        listener(current as AgentEvent);
      } catch {}
    }
    return () => this.listeners.delete(listener);
  }

  async prompt(
    message: string,
    options?: {
      streamingBehavior?: "steer" | "followUp";
      images?: any[];
      source?: string;
      requestTag?: string;
      expandPromptTemplates?: boolean;
    },
  ) {
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;
    if (expandPromptTemplates && (await this.tryExecuteLocalExtensionCommand(message))) {
      return;
    }
    if (
      options?.streamingBehavior === "steer" &&
      !this.isLocalExtensionCommand(message)
    ) {
      this.enqueuePending("steeringMessages", message);
    }
    if (
      options?.streamingBehavior === "followUp" &&
      !this.isLocalExtensionCommand(message)
    ) {
      this.enqueuePending("followUpMessages", message);
    }
    await this.sendOrQueue({
      mode: "prompt",
      message,
      images: options?.images,
      streamingBehavior: options?.streamingBehavior,
      source: options?.source,
      requestTag: this.ensureRequestTag(options?.requestTag),
    });
  }

  async resumeInterruptedTurn(options?: {
    source?: string;
    requestTag?: string;
  }) {
    await this.ensureRemoteSession();
    await this.call("resume_interrupted_turn", {
      source: options?.source,
      requestTag: this.ensureRequestTag(options?.requestTag),
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
      requestTag: this.ensureRequestTag(options?.requestTag),
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
      requestTag: this.ensureRequestTag(options?.requestTag),
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
    this.activeTurn = null;
    this.remoteTurnRunning = false;
    this.isCompacting = false;
    this.isBashRunning = false;
    this.retryAttempt = 0;
    this.syncStreamingState();
    void this.client.abort().catch(() => {});
  }

  async newSession(_options?: { parentSession?: string }) {
    this.setSessionOperationPending(true);
    try {
      const data = await this.call("new_session");
      await this.refreshState(REFRESH_ALL);
      return !Boolean(data?.cancelled);
    } finally {
      this.setSessionOperationPending(false);
    }
  }

  async switchSession(sessionPath: string, _cwdOverride?: string) {
    this.setSessionOperationPending(true);
    try {
      const data = await this.call("switch_session", { sessionPath });
      await this.refreshState(REFRESH_ALL);
      return !Boolean(data?.cancelled);
    } finally {
      this.setSessionOperationPending(false);
    }
  }

  async renameSession(sessionPath: string, name: string) {
    await this.call("rename_session", { sessionPath, name });
    if (this.sessionFile === sessionPath)
      await this.refreshState(REFRESH_SESSION);
  }

  async listSessions(
    scope: "all" = "all",
    _onProgress?: (loaded: number, total: number) => void,
  ) {
    if (!this.client.isConnected()) {
      await this.waitForDaemonAvailable();
    }
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
        const sessions = await this.listSessions("all");
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
    if (!this.client.isConnected()) return;
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
    this.setSessionOperationPending(true);
    try {
      const data = await this.call("import_jsonl", { inputPath });
      await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
      return !Boolean(data?.cancelled);
    } finally {
      this.setSessionOperationPending(false);
    }
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

  private getFrontendPhase(): RpcFrontendPhase {
    if (!this.rpcConnected) return "connecting";
    if (this.remoteTurnRunning || this.isCompacting) return "working";
    if (this.activeTurn) return "sending";
    if (
      this.startupPending ||
      this.sessionOperationPending ||
      this.recoveryPending
    ) {
      return "starting";
    }
    return "idle";
  }

  getFrontendStatusEvent() {
    const phase = this.getFrontendPhase();
    if (phase === "idle") return null;
    const label =
      phase === "connecting"
        ? "Connecting"
        : phase === "starting"
          ? "Starting"
          : phase === "sending"
            ? "Sending"
            : "Working";
    return {
      type: "rpc_frontend_status",
      phase,
      label,
      connected: this.rpcConnected,
    } as any;
  }

  private emitFrontendStatus(force = false) {
    const phase = this.getFrontendPhase();
    if (!force && phase === this.lastFrontendPhase) return;
    this.lastFrontendPhase = phase;
    const event = this.getFrontendStatusEvent();
    if (event) {
      this.emitEvent(event as AgentEvent);
      return;
    }
    this.emitEvent({ type: "rpc_frontend_status", phase: "idle" } as any);
  }

  private setSessionOperationPending(pending: boolean) {
    this.sessionOperationPending = pending;
    this.emitFrontendStatus(true);
  }

  private emitSessionResynced() {
    this.emitEvent({ type: "rpc_session_resynced" } as any);
  }

  private emitLocalUserMessage(text: string) {
    const nextText = String(text || "").trim();
    if (!nextText) return;
    this.emitEvent({ type: "rpc_local_user_message", text: nextText } as any);
  }

  private setRpcConnected(connected: boolean) {
    this.rpcConnected = connected;
    if (!connected) {
      this.remoteTurnRunning = false;
      this.activeTurn = null;
    }
    this.syncStreamingState();
  }

  private setRemoteTurnRunning(running: boolean) {
    this.remoteTurnRunning = running;
    this.syncStreamingState();
  }

  private syncStreamingState() {
    this.isStreaming = Boolean(
      this.rpcConnected && (this.remoteTurnRunning || this.activeTurn),
    );
    if (!this.isStreaming && !this.rpcConnected) this.activeTurn = null;
    this.emitFrontendStatus();
  }

  private ensureRequestTag(requestTag?: string) {
    const next = String(requestTag || "").trim();
    if (next) return next;
    this.nextRequestTagId += 1;
    return `rin-tui-${Date.now()}-${this.nextRequestTagId}`;
  }

  private clearWaitingDaemonState() {
    if (this.waitForDaemonHintTimer) clearTimeout(this.waitForDaemonHintTimer);
    this.waitForDaemonHintTimer = null;
    this.waitForDaemonPromise = null;
  }

  private async waitForDaemonAvailable() {
    if (this.client.isConnected() && this.rpcConnected && !this.recoveryPending) {
      return;
    }
    if (this.waitForDaemonPromise) return await this.waitForDaemonPromise;
    this.emitEvent({
      type: "status",
      level: "warning",
      text: "Waiting daemon...",
    } as any);
    this.waitForDaemonHintTimer = setTimeout(() => {
      this.waitForDaemonHintTimer = null;
      this.emitEvent({
        type: "status",
        level: "warning",
        text: "Daemon is still unavailable after 30s. Try `rin doctor` and `rin --std` to troubleshoot.",
      } as any);
    }, 30000);
    this.waitForDaemonPromise = this.ensureReconnectLoop().finally(() => {
      this.clearWaitingDaemonState();
    });
    return await this.waitForDaemonPromise;
  }

  private queueOfflineOperation(operation: PendingRpcOperation) {
    this.queuedOfflineOps.push(operation);
    void this.ensureReconnectLoop();
    this.emitFrontendStatus(true);
  }

  private async sendOrQueue(operation: PendingRpcOperation) {
    if (operation.mode === "prompt") this.emitLocalUserMessage(operation.message);
    if (!this.client.isConnected() || !this.rpcConnected || this.recoveryPending) {
      this.queueOfflineOperation(operation);
      return;
    }

    this.activeTurn = operation;
    this.syncStreamingState();

    const sendOperation = async () => {
      await this.ensureRemoteSession();
      await this.call(operation.mode, {
        message: operation.message,
        images: operation.images,
        streamingBehavior: operation.streamingBehavior,
        source: operation.source,
        requestTag: operation.requestTag,
      });
    };

    try {
      await sendOperation();
    } catch (error: any) {
      const message = String(error?.message || error || "");
      if (/rin_tui_not_connected|rin_disconnected/.test(message)) {
        this.activeTurn = null;
        this.syncStreamingState();
        this.queueOfflineOperation(operation);
        return;
      }
      if (/rin_no_attached_session/.test(message)) {
        this.activeTurn = null;
        this.syncStreamingState();
        this.handleSessionUnavailable();
        this.queueOfflineOperation(operation);
        return;
      }
      this.activeTurn = null;
      this.syncStreamingState();
      throw error;
    }
  }

  handleSessionUnavailable() {
    if (this.disposed) return;
    this.recoveryPending = true;
    this.setRpcConnected(false);
    void this.ensureReconnectLoop();
  }

  private handleConnectionLost() {
    this.handleSessionUnavailable();
  }

  private ensureReconnectLoop() {
    if (this.disposed) return Promise.resolve();
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnecting = true;
    this.emitFrontendStatus(true);
    this.reconnectPromise = (async () => {
      while (!this.disposed) {
        try {
          if (!this.client.isConnected()) {
            await this.client.connect();
          }
          if (!this.rpcConnected || this.recoveryPending) {
            await this.handleConnectionRestored();
          }
          if (this.client.isConnected() && this.rpcConnected && !this.recoveryPending) {
            return;
          }
        } catch {}
        await new Promise<void>((resolve) => {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            resolve();
          }, 1000);
        });
      }
      throw new Error("rin_tui_disposed");
    })().finally(() => {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectPromise = null;
      this.reconnecting = false;
      this.emitFrontendStatus(true);
    });
    return this.reconnectPromise;
  }

  private async handleConnectionRestored() {
    if (this.disposed) return;
    if (this.restorePromise) return await this.restorePromise;
    this.restorePromise = (async () => {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      try {
        if (this.sessionFile) {
          await this.call("switch_session", { sessionPath: this.sessionFile });
        } else if (this.sessionId) {
          await this.call("attach_session", { sessionId: this.sessionId });
        }
        await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
        this.setRpcConnected(true);
        this.recoveryPending = false;
        this.emitSessionResynced();
        this.emitFrontendStatus(true);
        const queued = [...this.queuedOfflineOps];
        this.queuedOfflineOps = [];
        for (const operation of queued) {
          await this.sendOrQueue(operation);
        }
      } catch (error) {
        this.setRpcConnected(false);
        this.recoveryPending = true;
        throw error;
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

  private getLocalExtensionCommand(text: string) {
    if (!text.startsWith("/")) return undefined;
    const extensionRunner = this.extensionRunner;
    if (!extensionRunner?.getCommand) return undefined;
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    return extensionRunner.getCommand(commandName);
  }

  private isLocalExtensionCommand(text: string) {
    return Boolean(this.getLocalExtensionCommand(text));
  }

  private async tryExecuteLocalExtensionCommand(text: string) {
    const command = this.getLocalExtensionCommand(text);
    if (!command) return false;

    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
    const ctx = this.extensionRunner?.createCommandContext?.();
    if (!ctx) return false;

    try {
      await command.handler(args, ctx);
    } catch (err) {
      this.extensionRunner?.emitError?.({
        extensionPath: `command:${commandName}`,
        event: "command",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
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
    const sessionScoped = isSessionScopedCommand(type);
    const send = async () =>
      await this.client.send({
        type,
        ...this.buildSessionCommandPayload(type, payload),
      });
    if (sessionScoped && !this.client.isConnected()) {
      await this.waitForDaemonAvailable();
    }
    let response: any;
    try {
      response = await send();
    } catch (error: any) {
      const message = String(error?.message || error || "");
      if (
        sessionScoped &&
        /rin_tui_not_connected|rin_disconnected/.test(message)
      ) {
        await this.waitForDaemonAvailable();
        response = await send();
      } else {
        throw error;
      }
    }
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
    this.syncStreamingState();
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
