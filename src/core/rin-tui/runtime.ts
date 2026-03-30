import type { AgentEvent, AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core'

import { loadRinCodingAgent } from '../rin-lib/loader.js'
import { getRuntimeSessionDir, resolveRuntimeProfile } from '../rin-lib/runtime.js'
import { RinDaemonFrontendClient } from './rpc-client.js'
import { createModelRegistry } from './rpc-model-registry.js'
import { createSettingsManager } from './settings-manager.js'
import { calculateContextTokens, computeAvailableThinkingLevels, estimateContextTokens, extractText, getLastAssistantText } from './session-helpers.js'

type RpcExtensionBindings = {
  uiContext?: any
  commandContextActions?: any
  shutdownHandler?: () => void
  onError?: (error: any) => void
}

const REFRESH_MESSAGES = { messages: true } as const
const REFRESH_MODELS = { models: true } as const
const REFRESH_SESSION = { session: true } as const
const REFRESH_MESSAGES_AND_SESSION = { messages: true, session: true } as const
const REFRESH_ALL = { messages: true, models: true, session: true } as const

class RemoteAgent {
  constructor(private client: RinDaemonFrontendClient) {}

  abort() {
    void this.client.abort().catch(() => {})
  }

  waitForIdle(timeout = 60000) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error('rin_wait_for_idle_timeout'))
      }, timeout)
      const unsubscribe = this.client.subscribe((event) => {
        if (event.type !== 'ui') return
        if ((event.payload as any)?.type !== 'agent_end') return
        clearTimeout(timer)
        unsubscribe()
        resolve()
      })
    })
  }

  async setTransport(_transport: string) {}
}

type RefreshFlags = { messages?: boolean; models?: boolean; session?: boolean }

const RUNTIME_PROFILE = resolveRuntimeProfile()
const RUNTIME_SESSION_DIR = getRuntimeSessionDir(RUNTIME_PROFILE.cwd, RUNTIME_PROFILE.agentDir)

export class RpcInteractiveSession {
  public agent: RemoteAgent
  public settingsManager: any
  public modelRegistry: any
  public resourceLoader: any
  public sessionManager: any

  public scopedModels: any[] = []
  public promptTemplates: any[] = []
  public extensionRunner: any = undefined
  public model: any = null
  public thinkingLevel: ThinkingLevel = 'medium'
  public steeringMode: 'all' | 'one-at-a-time' = 'all'
  public followUpMode: 'all' | 'one-at-a-time' = 'one-at-a-time'
  public systemPrompt = ''
  public isStreaming = false
  public isCompacting = false
  public isBashRunning = false
  public retryAttempt = 0
  public pendingMessageCount = 0
  public autoCompactionEnabled = false
  public messages: AgentMessage[] = []
  public state: any = { messages: this.messages, model: null, thinkingLevel: this.thinkingLevel }

  private sessionId = ''
  private sessionFile?: string
  private sessionName?: string
  private leafId: string | null = null
  private entries: any[] = []
  private tree: any[] = []
  private entryById = new Map<string, any>()
  private labelsById = new Map<string, string | undefined>()
  private lastSessionStats: any = undefined
  private steeringMessages: string[] = []
  private followUpMessages: string[] = []
  private detachedBlankSession = false
  private listeners = new Set<(event: AgentEvent) => void>()
  private unsubscribeClient?: () => void
  private extensionBindings: RpcExtensionBindings = {}
  private additionalExtensionPaths: string[]

  constructor(public client: RinDaemonFrontendClient, additionalExtensionPaths: string[] = []) {
    this.additionalExtensionPaths = [...additionalExtensionPaths]
    this.agent = new RemoteAgent(client)
    this.settingsManager = createSettingsManager()
    this.modelRegistry = createModelRegistry(client)
    this.resourceLoader = {
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getExtensions: () => ({ extensions: [], errors: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getPathMetadata: () => new Map(),
    }
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
        model: this.model ? { provider: this.model.provider, modelId: this.model.id } : null,
      }),
      getEntries: () => [...this.entries],
      getSessionName: () => this.sessionName,
      getTree: () => [...this.tree],
      getLeafId: () => this.leafId,
      appendLabelChange: (entryId: string, label: string | undefined) => void this.setEntryLabel(entryId, label).catch(() => {}),
      getCwd: () => RUNTIME_PROFILE.cwd,
      getSessionDir: () => RUNTIME_SESSION_DIR,
      appendSessionInfo: (name: string) => void this.setSessionName(name).catch(() => {}),
    }
  }

  async connect() {
    await this.client.connect()
    this.unsubscribeClient = this.client.subscribe((event) => {
      if (event.type !== 'ui') return
      const payload: any = event.payload
      if (!payload || payload.type === 'response') return
      if (payload.type === 'oauth_login_event') {
        this.modelRegistry.authStorage.handleEvent(payload)
        return
      }
      this.handleRpcEvent(payload)
    })
    await this.hydrateSettingsManager()
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION)
    void this.modelRegistry.sync().catch(() => {})
  }

  async disconnect() {
    this.unsubscribeClient?.()
    this.unsubscribeClient = undefined
    await this.client.disconnect()
  }

  subscribe(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prompt(message: string, options?: { streamingBehavior?: 'steer' | 'followUp'; images?: any[]; source?: string }) {
    if (options?.streamingBehavior === 'steer') return await this.interruptPrompt(message, options.images)
    if (options?.streamingBehavior === 'followUp') return await this.followUp(message, options.images)
    await this.ensureRemoteSession()
    this.isStreaming = true
    await this.call('prompt', { message, images: options?.images, source: options?.source })
  }

  async interruptPrompt(message: string, images?: any[]) {
    await this.ensureRemoteSession()
    this.isStreaming = true
    await this.call('interrupt_prompt', { message, images })
  }

  async steer(message: string, images?: any[]) {
    await this.ensureRemoteSession()
    this.enqueuePending('steeringMessages', message)
    this.isStreaming = true
    await this.call('steer', { message, images })
  }

  async followUp(message: string, images?: any[]) {
    await this.ensureRemoteSession()
    this.enqueuePending('followUpMessages', message)
    this.isStreaming = true
    await this.call('follow_up', { message, images })
  }

  clearQueue() {
    const queued = { steering: [...this.steeringMessages], followUp: [...this.followUpMessages] }
    this.steeringMessages = []
    this.followUpMessages = []
    this.syncPendingCount()
    return queued
  }

  getSteeringMessages() { return [...this.steeringMessages] }
  getFollowUpMessages() { return [...this.followUpMessages] }
  async abort() { await this.client.abort() }

  async newSession(_options?: { parentSession?: string }) {
    await this.client.send({ type: 'detach_session' }).catch(() => {})
    this.resetLocalSessionState()
    this.detachedBlankSession = true
    return true
  }

  async switchSession(sessionPath: string) {
    const data = await this.call('switch_session', { sessionPath })
    this.detachedBlankSession = false
    await this.refreshState(REFRESH_ALL)
    return !Boolean(data?.cancelled)
  }

  async renameSession(sessionPath: string, name: string) {
    await this.call('rename_session', { sessionPath, name })
    if (this.sessionFile === sessionPath) await this.refreshState(REFRESH_SESSION)
  }

  async listSessions(scope: 'cwd' | 'all' = 'cwd', _onProgress?: (loaded: number, total: number) => void) {
    const data = await this.call('list_sessions', { scope })
    return Array.isArray(data?.sessions) ? data.sessions : []
  }

  async setModel(model: any) {
    if (this.detachedBlankSession) {
      this.model = model
      this.state.model = model
      this.settingsManager.setDefaultModelAndProvider(model.provider, model.id)
      return
    }
    await this.call('set_model', { provider: model.provider, modelId: model.id })
    await this.refreshState(REFRESH_MODELS)
  }

  setScopedModels(scopedModels: Array<{ model: any; thinkingLevel?: ThinkingLevel }>) {
    this.scopedModels = [...scopedModels]
  }

  async cycleModel(direction?: 'forward' | 'backward') {
    if (this.detachedBlankSession) {
      const available = this.scopedModels.length > 0
        ? this.scopedModels.map((entry) => entry.model)
        : this.modelRegistry.getAvailable()
      if (available.length <= 1) return undefined
      const step = direction === 'backward' ? -1 : 1
      const currentIndex = Math.max(0, available.findIndex((model: any) => model?.provider === this.model?.provider && model?.id === this.model?.id))
      const next = available[(currentIndex + step + available.length) % available.length]
      if (!next) return undefined
      this.model = next
      this.state.model = next
      this.settingsManager.setDefaultModelAndProvider(next.provider, next.id)
      return { model: next, thinkingLevel: this.thinkingLevel }
    }
    const data = await this.call('cycle_model')
    await this.refreshState(REFRESH_MODELS)
    return data ?? undefined
  }

  setThinkingLevel(level: ThinkingLevel) {
    const available = this.getAvailableThinkingLevels()
    const next = available.includes(level) ? level : available[available.length - 1]!
    this.thinkingLevel = next
    this.state.thinkingLevel = next
    void this.client.send({ type: 'set_thinking_level', level: next }).catch(() => {})
  }

  cycleThinkingLevel(): ThinkingLevel | undefined {
    const levels = this.getAvailableThinkingLevels()
    if (levels.length <= 1) return undefined
    const next = levels[(Math.max(0, levels.indexOf(this.thinkingLevel)) + 1) % levels.length]!
    this.setThinkingLevel(next)
    return next
  }

  getAvailableThinkingLevels() { return computeAvailableThinkingLevels(this.model) }

  setSteeringMode(mode: 'all' | 'one-at-a-time') {
    this.steeringMode = mode
    this.settingsManager.setSteeringMode(mode)
    void this.client.send({ type: 'set_steering_mode', mode }).catch(() => {})
  }

  setFollowUpMode(mode: 'all' | 'one-at-a-time') {
    this.followUpMode = mode
    this.settingsManager.setFollowUpMode(mode)
    void this.client.send({ type: 'set_follow_up_mode', mode }).catch(() => {})
  }

  async compact(customInstructions?: string) {
    const data = await this.call('compact', { customInstructions })
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION)
    return data
  }

  abortCompaction() { void this.client.abort().catch(() => {}) }
  abortBranchSummary() {}

  setAutoCompactionEnabled(enabled: boolean) {
    this.autoCompactionEnabled = enabled
    void this.client.send({ type: 'set_auto_compaction', enabled }).catch(() => {})
  }

  async executeBash(command: string) {
    this.isBashRunning = true
    try {
      const data = await this.call('bash', { command })
      await this.refreshState(REFRESH_MESSAGES_AND_SESSION)
      return data
    } finally {
      this.isBashRunning = false
    }
  }

  recordBashResult(_command: string, _result: any, _options?: { excludeFromContext?: boolean }) {}

  async abortBash() {
    await this.call('abort_bash')
    this.isBashRunning = false
  }

  abortRetry() { void this.client.send({ type: 'abort_retry' }).catch(() => {}) }
  get isRetrying() { return this.retryAttempt > 0 }
  get autoRetryEnabled() { return false }
  setAutoRetryEnabled(_enabled: boolean) {}

  setSessionName(name: string) {
    this.sessionName = name
    return this.call('set_session_name', { name }).then(async () => {
      await this.refreshState(REFRESH_SESSION)
    })
  }

  async setEntryLabel(entryId: string, label: string | undefined) {
    await this.call('set_entry_label', { entryId, label })
    await this.refreshState(REFRESH_SESSION)
  }

  async fork(entryId: string) {
    const data = await this.call('fork', { entryId })
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION)
    return { cancelled: Boolean(data?.cancelled), selectedText: String(data?.text || '') }
  }

  async navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }) {
    const data = await this.call('navigate_tree', {
      targetId,
      summarize: options?.summarize,
      customInstructions: options?.customInstructions,
      replaceInstructions: options?.replaceInstructions,
      label: options?.label,
    })
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION)
    return {
      cancelled: Boolean(data?.cancelled),
      aborted: Boolean(data?.aborted),
      editorText: typeof data?.editorText === 'string' ? data.editorText : '',
      summaryEntry: data?.summaryEntry,
    }
  }

  getUserMessagesForForking() {
    return this.entries
      .filter((entry: any) => entry?.type === 'message' && entry.message?.role === 'user')
      .map((entry: any) => ({ entryId: String(entry.id), text: extractText(entry.message?.content) }))
      .filter((entry: any) => entry.text)
  }

  getSessionStats() {
    this.lastSessionStats = this.computeSessionStats()
    return this.lastSessionStats
  }

  getContextUsage() {
    const contextWindow = Number(this.model?.contextWindow || 0)
    if (contextWindow <= 0) return undefined

    const branch = this.getBranch()
    let latestCompactionIndex = -1
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i]?.type === 'compaction') {
        latestCompactionIndex = i
        break
      }
    }

    if (latestCompactionIndex >= 0) {
      let hasPostCompactionUsage = false
      for (let i = branch.length - 1; i > latestCompactionIndex; i--) {
        const entry = branch[i]
        const message: any = entry?.type === 'message' ? entry.message : null
        const usage = message?.role === 'assistant' ? message?.usage : undefined
        const stopReason = String(message?.stopReason || '')
        if (usage && stopReason !== 'aborted' && stopReason !== 'error') {
          if (calculateContextTokens(usage) > 0) hasPostCompactionUsage = true
          break
        }
      }
      if (!hasPostCompactionUsage) {
        return { tokens: null, contextWindow, percent: null }
      }
    }

    const tokens = estimateContextTokens(this.messages)
    return {
      tokens,
      contextWindow,
      percent: (tokens / contextWindow) * 100,
    }
  }

  async exportToHtml(outputPath?: string) {
    const data = await this.call('export_html', { outputPath })
    return String(data?.path || '')
  }

  async exportToJsonl(outputPath?: string) {
    const data = await this.call('export_jsonl', { outputPath })
    return String(data?.path || '')
  }

  async importFromJsonl(inputPath: string) {
    const data = await this.call('import_jsonl', { inputPath })
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION)
    return !Boolean(data?.cancelled)
  }

  getLastAssistantText() { return getLastAssistantText(this.messages) }
  getToolDefinition() { return undefined }

  async reload() {
    await this.modelRegistry.sync()
    if (!this.detachedBlankSession) {
      await this.refreshState(REFRESH_MESSAGES_AND_SESSION)
    }
    if (this.extensionRunner) {
      await this.loadLocalExtensions(true)
    }
  }

  async bindExtensions(bindings: RpcExtensionBindings = {}) {
    this.extensionBindings = {
      ...this.extensionBindings,
      ...bindings,
    }
    await this.loadLocalExtensions(false)
  }

  private async loadLocalExtensions(forceReload: boolean) {
    const codingAgentModule: any = await loadRinCodingAgent()
    const { createEventBus, discoverAndLoadExtensions, ExtensionRunner } = codingAgentModule

    const eventBus = createEventBus()
    const result = await discoverAndLoadExtensions(
      this.additionalExtensionPaths,
      RUNTIME_PROFILE.cwd,
      RUNTIME_PROFILE.agentDir,
      eventBus,
    )

    const runner = new ExtensionRunner(
      result.extensions,
      result.runtime,
      RUNTIME_PROFILE.cwd,
      this.sessionManager,
      this.modelRegistry,
    )

    runner.bindCore(
      {
        sendMessage: (message: string, options?: { images?: any[] }) => {
          void this.prompt(message, { images: options?.images, source: 'extension' as any }).catch(() => {})
        },
        sendUserMessage: (content: any) => {
          const text = extractText(content)
          if (!text) return
          void this.prompt(text, { source: 'extension' as any }).catch(() => {})
        },
        appendEntry: () => {},
        setSessionName: (name: string) => { void this.setSessionName(name).catch(() => {}) },
        getSessionName: () => this.sessionName,
        setLabel: (entryId: string, label: string | undefined) => { void this.setEntryLabel(entryId, label).catch(() => {}) },
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => {},
        refreshTools: () => {},
        getCommands: () => runner.getRegisteredCommands(),
        setModel: async (model: any) => { await this.setModel(model) },
        getThinkingLevel: () => this.thinkingLevel,
        setThinkingLevel: (level: ThinkingLevel) => { this.setThinkingLevel(level) },
      },
      {
        getModel: () => this.model,
        isIdle: () => !this.isStreaming,
        getSignal: () => undefined,
        abort: () => { void this.abort().catch(() => {}) },
        hasPendingMessages: () => this.pendingMessageCount > 0,
        shutdown: () => this.extensionBindings.shutdownHandler?.(),
        getContextUsage: () => this.getContextUsage(),
        compact: (options?: { customInstructions?: string }) => { void this.compact(options?.customInstructions).catch(() => {}) },
        getSystemPrompt: () => this.systemPrompt,
      },
    )

    runner.setUIContext(this.extensionBindings.uiContext)
    runner.bindCommandContext(this.extensionBindings.commandContextActions)
    if (this.extensionBindings.onError) runner.onError(this.extensionBindings.onError)

    this.extensionRunner = runner

    if (forceReload || result.extensions.length > 0) {
      await runner.emit({ type: 'session_start' })
    }
  }

  private handleRpcEvent(payload: any) {
    if (!payload || typeof payload !== 'object') return
    if (payload.type === 'agent_start') this.isStreaming = true
    if (payload.type === 'compaction_start') this.isCompacting = true
    if (payload.type === 'compaction_end') {
      this.isCompacting = false
      void this.refreshState(REFRESH_MESSAGES_AND_SESSION)
    }
    if (payload.type === 'auto_retry_start') this.retryAttempt = Number(payload.attempt || 1)
    if (payload.type === 'auto_retry_end') this.retryAttempt = 0
    if (payload.type === 'agent_end') {
      this.isStreaming = false
      void this.refreshState(REFRESH_MESSAGES_AND_SESSION)
    }
    if (payload.type === 'extension_ui_request') return
    for (const listener of this.listeners) {
      try { listener(payload as AgentEvent) } catch {}
    }
  }

  private enqueuePending(queue: 'steeringMessages' | 'followUpMessages', message: string) {
    this[queue].push(message)
    this.syncPendingCount()
  }

  private async hydrateSettingsManager() {
    try {
      const codingAgentModule: any = await loadRinCodingAgent()
      const SettingsManager = codingAgentModule?.SettingsManager
      if (!SettingsManager?.create) return
      const settings = SettingsManager.create(RUNTIME_PROFILE.cwd, RUNTIME_PROFILE.agentDir)
      this.settingsManager.setShowHardwareCursor(Boolean(settings.getShowHardwareCursor?.()))
      this.settingsManager.setClearOnShrink(Boolean(settings.getClearOnShrink?.()))
      this.settingsManager.setEditorPaddingX(Number(settings.getEditorPaddingX?.() ?? 0))
      this.settingsManager.setAutocompleteMaxVisible(Number(settings.getAutocompleteMaxVisible?.() ?? 8))
      this.settingsManager.setHideThinkingBlock(Boolean(settings.getHideThinkingBlock?.()))
      this.settingsManager.setTheme(String(settings.getTheme?.() || 'dark'))
      this.settingsManager.setEnableSkillCommands(Boolean(settings.getEnableSkillCommands?.()))
      this.settingsManager.setShowImages(Boolean(settings.getShowImages?.()))
      this.settingsManager.setImageAutoResize(Boolean(settings.getImageAutoResize?.()))
      this.settingsManager.setBlockImages(Boolean(settings.getBlockImages?.()))
      this.settingsManager.setTransport(String(settings.getTransport?.() || 'stdio'))
      this.settingsManager.setCollapseChangelog(Boolean(settings.getCollapseChangelog?.()))
      this.settingsManager.setDoubleEscapeAction(String(settings.getDoubleEscapeAction?.() || 'none'))
      this.settingsManager.setTreeFilterMode(String(settings.getTreeFilterMode?.() || 'all'))
      this.settingsManager.setQuietStartup(Boolean(settings.getQuietStartup?.()))
      this.settingsManager.setLastChangelogVersion(settings.getLastChangelogVersion?.())
      this.settingsManager.setEnabledModels(settings.getEnabledModels?.())
      this.settingsManager.setSteeringMode(settings.getSteeringMode?.() || 'all')
      this.settingsManager.setFollowUpMode(settings.getFollowUpMode?.() || 'one-at-a-time')
      const provider = String(settings.getDefaultProvider?.() || '')
      const modelId = String(settings.getDefaultModel?.() || '')
      if (provider && modelId) this.settingsManager.setDefaultModelAndProvider(provider, modelId)
    } catch {}
  }

  private resetLocalSessionState() {
    this.isStreaming = false
    this.isCompacting = false
    this.isBashRunning = false
    this.retryAttempt = 0
    this.messages = []
    this.entries = []
    this.tree = []
    this.leafId = null
    this.entryById = new Map()
    this.labelsById = new Map()
    this.sessionFile = undefined
    this.sessionId = ''
    this.sessionName = undefined
    this.lastSessionStats = undefined
    this.clearQueue()
    this.state = { ...this.state, messages: this.messages, model: this.model, thinkingLevel: this.thinkingLevel }
  }

  private async ensureRemoteSession() {
    if (!this.detachedBlankSession && this.sessionFile) return
    const data = await this.call('new_session')
    if (data && data.cancelled) throw new Error('rin_new_session_cancelled')

    if (this.model) {
      await this.call('set_model', { provider: this.model.provider, modelId: this.model.id })
    }
    await this.call('set_thinking_level', { level: this.thinkingLevel })
    await this.call('set_steering_mode', { mode: this.steeringMode })
    await this.call('set_follow_up_mode', { mode: this.followUpMode })
    await this.call('set_auto_compaction', { enabled: this.autoCompactionEnabled })

    this.detachedBlankSession = false
    await this.refreshState(REFRESH_ALL)
  }

  private async call(type: string, payload: Record<string, unknown> = {}) {
    const response: any = await this.client.send({ type, ...payload })
    if (!response || response.success !== true) {
      throw new Error(String(response?.error || 'rin_request_failed'))
    }
    return response.data
  }

  private async refreshState(flags: RefreshFlags = {}) {
    this.applyState(await this.call('get_state'))
    await Promise.all([
      flags.models ? this.modelRegistry.sync() : Promise.resolve(),
      flags.messages ? this.refreshMessages() : Promise.resolve(),
      flags.session ? this.refreshSessionData() : Promise.resolve(),
    ])
    this.reconcilePendingQueues(this.pendingMessageCount)
    this.lastSessionStats = this.computeSessionStats()
  }

  private applyState(state: any) {
    this.model = state?.model ?? null
    this.thinkingLevel = state?.thinkingLevel ?? this.thinkingLevel
    this.steeringMode = state?.steeringMode ?? this.steeringMode
    this.followUpMode = state?.followUpMode ?? this.followUpMode
    this.isStreaming = Boolean(state?.isStreaming)
    this.isCompacting = Boolean(state?.isCompacting)
    this.pendingMessageCount = Number(state?.pendingMessageCount || 0)
    this.autoCompactionEnabled = Boolean(state?.autoCompactionEnabled)
    this.sessionId = String(state?.sessionId || this.sessionId || '')
    this.sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : undefined
    this.sessionName = typeof state?.sessionName === 'string' ? state.sessionName : this.sessionName
    if (this.sessionFile) this.detachedBlankSession = false
    this.state.model = this.model
    this.state.thinkingLevel = this.thinkingLevel
    this.settingsManager.setSteeringMode(this.steeringMode)
    this.settingsManager.setFollowUpMode(this.followUpMode)
  }

  private async refreshMessages() {
    const data = await this.call('get_messages')
    this.messages = Array.isArray(data?.messages) ? data.messages : []
    this.state.messages = this.messages
  }

  private async refreshSessionData() {
    const [entriesData, treeData] = await Promise.all([
      this.call('get_session_entries'),
      this.call('get_session_tree'),
    ])
    this.entries = Array.isArray(entriesData?.entries) ? entriesData.entries : []
    this.tree = Array.isArray(treeData?.tree) ? treeData.tree : []
    this.leafId = typeof treeData?.leafId === 'string' ? treeData.leafId : null
    this.entryById = new Map(this.entries.map((entry: any) => [String(entry.id), entry]))
    this.labelsById = new Map()
    this.visitTree(this.tree, (node) => {
      if (node?.entry?.id) this.labelsById.set(String(node.entry.id), node.label)
    })
  }

  private visitTree(nodes: any[], visit: (node: any) => void) {
    for (const node of nodes) {
      visit(node)
      if (Array.isArray(node?.children)) this.visitTree(node.children, visit)
    }
  }

  private getBranch(fromId?: string) {
    const targetId = fromId ?? this.leafId
    if (!targetId) return []
    const branch: any[] = []
    let current = this.entryById.get(targetId)
    while (current) {
      branch.push(current)
      if (!current.parentId) break
      current = this.entryById.get(current.parentId)
    }
    return branch.reverse()
  }

  private computeSessionStats() {
    let userMessages = 0
    let assistantMessages = 0
    let toolCalls = 0
    let toolResults = 0
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheWrite = 0
    let cost = 0

    for (const entry of this.entries) {
      if (entry?.type !== 'message' || !entry.message) continue
      const message = entry.message
      if (message.role === 'user') userMessages += 1
      if (message.role === 'assistant') {
        assistantMessages += 1
        const usage = (message as any).usage || {}
        input += Number(usage.input || 0)
        output += Number(usage.output || 0)
        cacheRead += Number(usage.cacheRead || 0)
        cacheWrite += Number(usage.cacheWrite || 0)
        cost += Number(usage.cost?.total || 0)
        for (const part of Array.isArray((message as any).content) ? (message as any).content : []) {
          if (part?.type === 'toolCall') toolCalls += 1
        }
      }
      if (message.role === 'toolResult') toolResults += 1
    }

    const contextWindow = Number(this.model?.contextWindow || 0)
    const totalTokens = input + output + cacheRead + cacheWrite
    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: userMessages + assistantMessages + toolResults,
      tokens: { input, output, cacheRead, cacheWrite, total: totalTokens },
      cost,
      contextUsage: this.getContextUsage(),
    }
  }

  private reconcilePendingQueues(targetCount: number) {
    let total = this.steeringMessages.length + this.followUpMessages.length
    while (total > targetCount && this.steeringMessages.length > 0) {
      this.steeringMessages.shift()
      total -= 1
    }
    while (total > targetCount && this.followUpMessages.length > 0) {
      this.followUpMessages.shift()
      total -= 1
    }
  }

  private syncPendingCount() {
    this.pendingMessageCount = this.steeringMessages.length + this.followUpMessages.length
  }
}
