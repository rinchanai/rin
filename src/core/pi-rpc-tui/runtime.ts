import type { AgentEvent, AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core'

import { getRuntimeSessionDir, resolveRuntimeProfile } from '../pi-rpc-lib/runtime.js'
import { PiRpcDaemonFrontendClient } from './rpc-client.js'

const ALL_THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
const REFRESH_MESSAGES = { messages: true } as const
const REFRESH_MODELS = { models: true } as const
const REFRESH_SESSION = { session: true } as const
const REFRESH_MESSAGES_AND_SESSION = { messages: true, session: true } as const
const REFRESH_ALL = { messages: true, models: true, session: true } as const

function extractText(value: any): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      if (part.type === 'text') return String(part.text || '')
      if (part.type === 'thinking') return String(part.thinking || '')
      return ''
    })
    .filter(Boolean)
    .join('')
}

function computeAvailableThinkingLevels(model: any): ThinkingLevel[] {
  if (!model?.reasoning) return ['off']
  const id = String(model?.id || '').toLowerCase()
  const provider = String(model?.provider || '').toLowerCase()
  return provider === 'openai' && id.includes('codex-max')
    ? ALL_THINKING_LEVELS
    : ['off', 'minimal', 'low', 'medium', 'high']
}

function getLastAssistantText(messages: AgentMessage[]) {
  for (const message of [...messages].reverse()) {
    if ((message as any)?.role !== 'assistant') continue
    const text = extractText((message as any).content)
    if (text) return text
  }
  return undefined
}

function createSettingsManager() {
  const values = {
    showHardwareCursor: false,
    clearOnShrink: false,
    editorPaddingX: 1,
    autocompleteMaxVisible: 8,
    hideThinkingBlock: false,
    theme: 'dark',
    enableSkillCommands: false,
    showImages: true,
    imageAutoResize: true,
    blockImages: false,
    transport: 'stdio',
    collapseChangelog: false,
    doubleEscapeAction: 'none',
    treeFilterMode: 'all',
    quietStartup: false,
    codeBlockIndent: '  ',
    branchSummarySkipPrompt: false,
    lastChangelogVersion: undefined as string | undefined,
    enabledModels: undefined as string[] | undefined,
    defaultProvider: undefined as string | undefined,
    defaultModel: undefined as string | undefined,
    steeringMode: 'all' as 'all' | 'one-at-a-time',
    followUpMode: 'one-at-a-time' as 'all' | 'one-at-a-time',
  }
  const globalSettings = {
    packages: [] as any[],
    extensions: [] as string[],
    skills: [] as string[],
    prompts: [] as string[],
    themes: [] as string[],
  }
  const projectSettings = {
    packages: [] as any[],
    extensions: [] as string[],
    skills: [] as string[],
    prompts: [] as string[],
    themes: [] as string[],
  }
  return {
    getShowHardwareCursor: () => values.showHardwareCursor,
    getClearOnShrink: () => values.clearOnShrink,
    getEditorPaddingX: () => values.editorPaddingX,
    getAutocompleteMaxVisible: () => values.autocompleteMaxVisible,
    getHideThinkingBlock: () => values.hideThinkingBlock,
    getTheme: () => values.theme,
    getEnableSkillCommands: () => values.enableSkillCommands,
    getShowImages: () => values.showImages,
    getImageAutoResize: () => values.imageAutoResize,
    getBlockImages: () => values.blockImages,
    getTransport: () => values.transport,
    getCollapseChangelog: () => values.collapseChangelog,
    getDoubleEscapeAction: () => values.doubleEscapeAction,
    getTreeFilterMode: () => values.treeFilterMode,
    getQuietStartup: () => values.quietStartup,
    getLastChangelogVersion: () => values.lastChangelogVersion,
    getEnabledModels: () => values.enabledModels,
    getSteeringMode: () => values.steeringMode,
    getFollowUpMode: () => values.followUpMode,
    getCodeBlockIndent: () => values.codeBlockIndent,
    getBranchSummarySkipPrompt: () => values.branchSummarySkipPrompt,
    getGlobalSettings: () => ({ ...globalSettings }),
    getProjectSettings: () => ({ ...projectSettings }),
    setShowImages: (v: boolean) => { values.showImages = v },
    setImageAutoResize: (v: boolean) => { values.imageAutoResize = v },
    setBlockImages: (v: boolean) => { values.blockImages = v },
    setEnableSkillCommands: (v: boolean) => { values.enableSkillCommands = v },
    setTransport: (v: string) => { values.transport = v },
    setTheme: (v: string) => { values.theme = v },
    setHideThinkingBlock: (v: boolean) => { values.hideThinkingBlock = v },
    setCollapseChangelog: (v: boolean) => { values.collapseChangelog = v },
    setQuietStartup: (v: boolean) => { values.quietStartup = v },
    setDoubleEscapeAction: (v: string) => { values.doubleEscapeAction = v },
    setTreeFilterMode: (v: string) => { values.treeFilterMode = v },
    setShowHardwareCursor: (v: boolean) => { values.showHardwareCursor = v },
    setEditorPaddingX: (v: number) => { values.editorPaddingX = v },
    setAutocompleteMaxVisible: (v: number) => { values.autocompleteMaxVisible = v },
    setClearOnShrink: (v: boolean) => { values.clearOnShrink = v },
    setLastChangelogVersion: (v?: string) => { values.lastChangelogVersion = v },
    setEnabledModels: (v?: string[]) => { values.enabledModels = v && v.length ? [...v] : undefined },
    setSteeringMode: (v: 'all' | 'one-at-a-time') => { values.steeringMode = v },
    setFollowUpMode: (v: 'all' | 'one-at-a-time') => { values.followUpMode = v },
    setDefaultModelAndProvider: (provider: string, modelId: string) => {
      values.defaultProvider = provider
      values.defaultModel = modelId
    },
    setPackages: (v: any[]) => { globalSettings.packages = [...v] },
    setProjectPackages: (v: any[]) => { projectSettings.packages = [...v] },
    setExtensionPaths: (v: string[]) => { globalSettings.extensions = [...v] },
    setProjectExtensionPaths: (v: string[]) => { projectSettings.extensions = [...v] },
    setSkillPaths: (v: string[]) => { globalSettings.skills = [...v] },
    setProjectSkillPaths: (v: string[]) => { projectSettings.skills = [...v] },
    setPromptTemplatePaths: (v: string[]) => { globalSettings.prompts = [...v] },
    setProjectPromptTemplatePaths: (v: string[]) => { projectSettings.prompts = [...v] },
    setThemePaths: (v: string[]) => { globalSettings.themes = [...v] },
    setProjectThemePaths: (v: string[]) => { projectSettings.themes = [...v] },
  }
}

function createAuthStorageProxy(client: PiRpcDaemonFrontendClient) {
  const state = {
    credentials: {} as Record<string, { type: string } | undefined>,
    providers: [] as Array<{ id: string; name: string; usesCallbackServer?: boolean }>,
    logins: new Map<string, {
      onAuth?: (info: { url: string; instructions?: string }) => void
      onPrompt?: (prompt: { message: string; placeholder?: string }) => Promise<string>
      onProgress?: (message: string) => void
      onManualCodeInput?: () => Promise<string>
      resolve: () => void
      reject: (error: Error) => void
    }>(),
  }

  const applyState = (data: any) => {
    state.credentials = data && typeof data.credentials === 'object' && data.credentials ? data.credentials : {}
    state.providers = Array.isArray(data?.providers) ? data.providers : []
  }

  const handleEvent = (payload: any) => {
    if (!payload || payload.type !== 'oauth_login_event') return
    const login = state.logins.get(String(payload.loginId || ''))
    if (!login) return

    if (payload.event === 'auth') {
      login.onAuth?.({ url: String(payload.url || ''), instructions: typeof payload.instructions === 'string' ? payload.instructions : undefined })
      return
    }
    if (payload.event === 'progress') {
      login.onProgress?.(String(payload.message || ''))
      return
    }
    if (payload.event === 'prompt') {
      Promise.resolve(login.onPrompt?.({ message: String(payload.message || ''), placeholder: typeof payload.placeholder === 'string' ? payload.placeholder : undefined }) ?? '')
        .then((value) => client.send({ type: 'oauth_login_respond', loginId: payload.loginId, requestId: payload.requestId, value }).catch(() => {}))
        .catch(() => client.send({ type: 'oauth_login_cancel', loginId: payload.loginId }).catch(() => {}))
      return
    }
    if (payload.event === 'manual_code') {
      Promise.resolve(login.onManualCodeInput?.() ?? '')
        .then((value) => client.send({ type: 'oauth_login_respond', loginId: payload.loginId, requestId: payload.requestId, value }).catch(() => {}))
        .catch(() => client.send({ type: 'oauth_login_cancel', loginId: payload.loginId }).catch(() => {}))
      return
    }
    if (payload.event === 'complete') {
      state.logins.delete(String(payload.loginId || ''))
      if (payload.state) applyState(payload.state)
      if (payload.success === true) login.resolve()
      else login.reject(new Error(String(payload.error || 'oauth_login_failed')))
    }
  }

  return {
    list: () => Object.keys(state.credentials),
    get: (providerId: string) => state.credentials[providerId],
    getOAuthProviders: () => [...state.providers],
    applyState,
    async sync() {
      const response: any = await client.send({ type: 'get_oauth_state' })
      const data: any = response && response.success === true ? response.data : null
      applyState(data)
    },
    logout(providerId: string) {
      delete state.credentials[providerId]
      void client.send({ type: 'oauth_logout', providerId }).then((response: any) => {
        if (response?.success === true) applyState(response.data)
      }).catch(() => {})
    },
    async login(providerId: string, callbacks: any = {}) {
      const response: any = await client.send({ type: 'oauth_login_start', providerId })
      if (!response || response.success !== true || !response.data?.loginId) {
        throw new Error(String(response?.error || 'oauth_login_failed'))
      }
      const loginId = String(response.data.loginId)
      await new Promise<void>((resolve, reject) => {
        state.logins.set(loginId, {
          onAuth: callbacks.onAuth,
          onPrompt: callbacks.onPrompt,
          onProgress: callbacks.onProgress,
          onManualCodeInput: callbacks.onManualCodeInput,
          resolve,
          reject,
        })
        if (callbacks.signal) {
          const abortHandler = () => {
            void client.send({ type: 'oauth_login_cancel', loginId }).catch(() => {})
            state.logins.delete(loginId)
            reject(new Error('Login cancelled'))
          }
          if (callbacks.signal.aborted) abortHandler()
          else callbacks.signal.addEventListener('abort', abortHandler, { once: true })
        }
      })
    },
    handleEvent,
  }
}

function createModelRegistry(client: PiRpcDaemonFrontendClient) {
  const state = { models: [] as any[], error: undefined as string | undefined }
  const authStorage = createAuthStorageProxy(client)
  return {
    authStorage,
    refresh() { void this.sync() },
    getError() { return state.error },
    getAvailable() { return [...state.models] },
    find(provider: string, modelId: string) {
      return state.models.find((model) => model.provider === provider && model.id === modelId)
    },
    isUsingOAuth(model: any) { return authStorage.get(model?.provider)?.type === 'oauth' },
    async sync() {
      try {
        const [modelsResponse, oauthResponse]: any = await Promise.all([
          client.send({ type: 'get_available_models' }),
          client.send({ type: 'get_oauth_state' }),
        ])
        const modelsData: any = modelsResponse && modelsResponse.success === true ? modelsResponse.data : null
        state.models = Array.isArray(modelsData?.models) ? modelsData.models : []
        state.error = undefined
        const oauthData: any = oauthResponse && oauthResponse.success === true ? oauthResponse.data : null
        authStorage.applyState(oauthData)
      } catch (error: any) {
        state.error = String(error?.message || error || 'pi_rpc_model_registry_failed')
      }
    },
  }
}

class RemoteAgent {
  constructor(private client: PiRpcDaemonFrontendClient) {}

  waitForIdle(timeout = 60000) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error('pi_rpc_wait_for_idle_timeout'))
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
  private listeners = new Set<(event: AgentEvent) => void>()
  private unsubscribeClient?: () => void

  constructor(public client: PiRpcDaemonFrontendClient) {
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
    await this.refreshState(REFRESH_ALL)
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

  async prompt(message: string, options?: { streamingBehavior?: 'steer' | 'followUp'; images?: any[] }) {
    if (options?.streamingBehavior === 'steer') return await this.interruptPrompt(message, options.images)
    if (options?.streamingBehavior === 'followUp') return await this.followUp(message, options.images)
    await this.call('prompt', { message, images: options?.images })
  }

  async interruptPrompt(message: string, images?: any[]) {
    await this.call('interrupt_prompt', { message, images })
  }

  async steer(message: string, images?: any[]) {
    this.enqueuePending('steeringMessages', message)
    await this.call('steer', { message, images })
  }

  async followUp(message: string, images?: any[]) {
    this.enqueuePending('followUpMessages', message)
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

  async newSession(options?: { parentSession?: string }) {
    const data = await this.call('new_session', { parentSession: options?.parentSession })
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION)
    this.clearQueue()
    return !Boolean(data?.cancelled)
  }

  async switchSession(sessionPath: string) {
    const data = await this.call('switch_session', { sessionPath })
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION)
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
    await this.call('set_model', { provider: model.provider, modelId: model.id })
    await this.refreshState(REFRESH_MODELS)
  }

  setScopedModels(scopedModels: Array<{ model: any; thinkingLevel?: ThinkingLevel }>) {
    this.scopedModels = [...scopedModels]
  }

  async cycleModel(_direction?: 'forward' | 'backward') {
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

  getContextUsage() { return this.lastSessionStats?.contextUsage }

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
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION)
  }

  async bindExtensions() {}

  private handleRpcEvent(payload: any) {
    if (!payload || typeof payload !== 'object') return
    if (payload.type === 'agent_start') this.isStreaming = true
    if (payload.type === 'auto_compaction_start') this.isCompacting = true
    if (payload.type === 'auto_compaction_end') this.isCompacting = false
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

  private async call(type: string, payload: Record<string, unknown> = {}) {
    const response: any = await this.client.send({ type, ...payload })
    if (!response || response.success !== true) {
      throw new Error(String(response?.error || 'pi_rpc_request_failed'))
    }
    return response.data
  }

  private async refreshState(flags: RefreshFlags = {}) {
    this.applyState(await this.call('get_state'))
    if (flags.models) await this.modelRegistry.sync()
    if (flags.messages) await this.refreshMessages()
    if (flags.session) await this.refreshSessionData()
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
      contextUsage: contextWindow > 0
        ? { tokens: totalTokens, contextWindow, percent: totalTokens > 0 ? (totalTokens / contextWindow) * 100 : 0 }
        : undefined,
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
