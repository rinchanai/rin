#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

import { parseJsonl } from '../rin-lib/common.js'
import { loadRinSessionManagerModule } from '../rin-lib/loader.js'
import { createConfiguredAgentSession } from '../rin-lib/runtime.js'

const BUILTIN_SLASH_COMMANDS = [
  { name: 'settings', description: 'Open settings menu' },
  { name: 'model', description: 'Select model (opens selector UI)' },
  { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling' },
  { name: 'export', description: 'Export session (HTML default, or specify path: .html/.jsonl)' },
  { name: 'import', description: 'Import and resume a session from a JSONL file' },
  { name: 'share', description: 'Share session as a secret GitHub gist' },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'changelog', description: 'Show changelog entries' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  { name: 'fork', description: 'Create a new fork from a previous message' },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  { name: 'login', description: 'Login with OAuth provider' },
  { name: 'logout', description: 'Logout from OAuth provider' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, and themes' },
  { name: 'quit', description: 'Quit pi' },
]

function writeJsonLine(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function response(id: string | undefined, command: string, success: boolean, payload?: unknown) {
  return success
    ? payload === undefined
      ? { id, type: 'response', command, success: true }
      : { id, type: 'response', command, success: true, data: payload }
    : { id, type: 'response', command, success: false, error: String((payload as any)?.message || payload || 'rin_request_failed') }
}

function ok(id: string | undefined, command: string, data?: unknown) {
  return response(id, command, true, data)
}

function fail(id: string | undefined, command: string, error: unknown) {
  return response(id, command, false, error)
}

function getSessionState(session: any) {
  return {
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    autoCompactionEnabled: session.autoCompactionEnabled,
    messageCount: session.messages.length,
    pendingMessageCount: session.pendingMessageCount,
  }
}

function getSlashCommands(session: any, builtinSlashCommands: any[] = []) {
  const commands: any[] = []

  for (const command of builtinSlashCommands) {
    commands.push({ name: command.name, description: command.description, source: 'builtin' })
  }
  for (const command of session.extensionRunner?.getRegisteredCommands?.() ?? []) {
    commands.push({ name: command.invocationName, description: command.description, source: 'extension', sourceInfo: command.sourceInfo })
  }
  for (const template of session.promptTemplates ?? []) {
    commands.push({ name: template.name, description: template.description, source: 'prompt', sourceInfo: template.sourceInfo })
  }
  for (const skill of session.resourceLoader?.getSkills?.().skills ?? []) {
    commands.push({ name: `skill:${skill.name}`, description: skill.description, source: 'skill', sourceInfo: skill.sourceInfo })
  }

  return commands
}

function getOAuthState(session: any) {
  const authStorage = session.modelRegistry.authStorage
  const credentials = Object.fromEntries(
    authStorage.list().map((providerId: string) => {
      const credential = authStorage.get(providerId)
      return [providerId, credential ? { type: credential.type } : undefined]
    }),
  )
  const providers = authStorage.getOAuthProviders().map((provider: any) => ({
    id: provider.id,
    name: provider.name,
    usesCallbackServer: Boolean(provider.usesCallbackServer),
  }))
  return { credentials, providers }
}

function splitCommandArgs(text: string) {
  const args: string[] = []
  let current = ''
  let quote: string | null = null

  for (const char of String(text || '')) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ' ' || char === '\t') {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (current) args.push(current)
  return args
}

function formatSessionStats(stats: any) {
  return [
    `Session ID: ${String(stats?.sessionId || '')}`,
    `Session File: ${String(stats?.sessionFile || 'In-memory')}`,
    `Messages: ${String(stats?.totalMessages || 0)} (user=${String(stats?.userMessages || 0)}, assistant=${String(stats?.assistantMessages || 0)}, toolResults=${String(stats?.toolResults || 0)})`,
    `Tool Calls: ${String(stats?.toolCalls || 0)}`,
    `Tokens: ${String(stats?.tokens?.total || 0)} (input=${String(stats?.tokens?.input || 0)}, output=${String(stats?.tokens?.output || 0)}, cacheRead=${String(stats?.tokens?.cacheRead || 0)}, cacheWrite=${String(stats?.tokens?.cacheWrite || 0)})`,
    `Cost: ${String(stats?.cost || 0)}`,
  ].join('\n')
}

async function runBuiltinCommand(session: any, commandLine: string, deps: { SessionManager: any }) {
  const trimmed = String(commandLine || '').trim()
  if (!trimmed.startsWith('/')) return { handled: false }

  const [name = '', ...rest] = splitCommandArgs(trimmed.slice(1))
  const argsText = rest.join(' ').trim()
  const command = name.trim()
  if (!command) return { handled: false }

  switch (command) {
    case 'new':
      await session.newSession()
      return { handled: true, text: 'Started a new session.' }

    case 'compact':
      await session.compact(argsText || undefined)
      return { handled: true, text: 'Compacted session.' }

    case 'reload':
      await session.reload()
      return { handled: true, text: 'Reloaded extensions, prompts, skills, and themes.' }

    case 'session':
      return { handled: true, text: formatSessionStats(session.getSessionStats()) }

    case 'resume': {
      const sessions = await deps.SessionManager.list(session.sessionManager.getCwd(), session.sessionManager.getSessionDir())
      if (!argsText) {
        const lines = sessions.slice(0, 20).map((item: any) => {
          const label = String(item?.name || item?.id || '').trim() || String(item?.id || '')
          return `${String(item?.id || '')} — ${label}`
        })
        return { handled: true, text: lines.length ? ['Available sessions:', ...lines].join('\n') : 'No sessions available.' }
      }
      const match = sessions.find((item: any) => String(item?.id || '') === argsText)
      if (!match) return { handled: true, text: `Session not found: ${argsText}` }
      await session.switchSession(String(match.path || ''))
      return { handled: true, text: `Resumed session: ${String(match.id || '')}` }
    }

    case 'model': {
      if (!rest.length) {
        const models = await session.modelRegistry.getAvailable()
        const lines = models.slice(0, 50).map((model: any) => `${String(model.provider || '')}/${String(model.id || '')}`)
        return { handled: true, text: lines.length ? ['Available models:', ...lines].join('\n') : 'No models available.' }
      }
      const [targetRef = '', thinkingLevel = ''] = rest
      const [provider = '', modelId = ''] = String(targetRef).split('/', 2)
      if (!provider || !modelId) {
        return { handled: true, text: 'Usage: /model <provider/model> [thinking-level]' }
      }
      const models = await session.modelRegistry.getAvailable()
      const match = models.find((model: any) => model.provider === provider && model.id === modelId)
      if (!match) return { handled: true, text: `Model not found: ${targetRef}` }
      await session.setModel(match)
      if (thinkingLevel) await session.setThinkingLevel(thinkingLevel)
      return { handled: true, text: `Model set to: ${provider}/${modelId}${thinkingLevel ? ` (${thinkingLevel})` : ''}` }
    }

    default:
      return { handled: false }
  }
}

async function runCustomRpcMode(session: any, deps: { SessionManager: any; builtinSlashCommands: any[] }) {
  const { SessionManager, builtinSlashCommands } = deps
  const output = (obj: unknown) => writeJsonLine(obj)
  const done = (id: string | undefined, type: string, value?: unknown) => ok(id, type, value)
  const run = async (id: string | undefined, type: string, fn: () => any, map?: (value: any) => any) => {
    const value = await fn()
    return done(id, type, map ? map(value) : value)
  }
  let activeTurnPromise: Promise<void> | null = null
  let interruptQueue = Promise.resolve()
  const emitTurnEvent = (event: string, requestTag: string, payload: Record<string, unknown> = {}) => {
    if (!requestTag) return
    output({ type: 'rpc_turn_event', event, requestTag, ...payload })
  }
  const startTurnTask = (requestTag: string, task: () => Promise<void>) => {
    const promise = (async () => {
      emitTurnEvent('start', requestTag)
      try {
        await task()
        await session.agent.waitForIdle()
        emitTurnEvent('complete', requestTag, { sessionFile: session.sessionFile })
      } catch (error: any) {
        emitTurnEvent('error', requestTag, { error: String(error?.message || error || 'rpc_turn_failed') })
        throw error
      } finally {
        if (activeTurnPromise === promise) activeTurnPromise = null
      }
    })()
    activeTurnPromise = promise
    promise.catch(() => {})
  }
  const startInterruptTurnTask = (requestTag: string, task: () => Promise<void>) => {
    interruptQueue = interruptQueue.then(async () => {
      if (session.isStreaming || session.isCompacting) {
        await session.abort()
      }
      try { await activeTurnPromise } catch {}
      startTurnTask(requestTag, task)
    }, async () => {
      if (session.isStreaming || session.isCompacting) {
        await session.abort()
      }
      try { await activeTurnPromise } catch {}
      startTurnTask(requestTag, task)
    }).catch(() => {})
  }
  let loginSeq = 0
  const activeLogins = new Map<string, { abort: AbortController; waits: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }> }>()
  const emitLoginEvent = (loginId: string, event: string, payload: Record<string, unknown> = {}) => {
    output({ type: 'oauth_login_event', loginId, event, ...payload })
  }
  const ensureLogin = (loginId: string) => {
    const login = activeLogins.get(loginId)
    if (!login) throw new Error(`Unknown OAuth login: ${loginId}`)
    return login
  }
  const waitForLoginInput = (loginId: string, kind: string, payload: Record<string, unknown> = {}) => {
    const login = ensureLogin(loginId)
    const requestId = `${loginId}:${kind}:${login.waits.size + 1}`
    emitLoginEvent(loginId, kind, { requestId, ...payload })
    return new Promise<string>((resolve, reject) => {
      login.waits.set(requestId, { resolve, reject })
    })
  }
  const finishLogin = (loginId: string) => {
    const login = activeLogins.get(loginId)
    if (!login) return
    for (const pending of login.waits.values()) pending.reject(new Error('OAuth login cancelled'))
    activeLogins.delete(loginId)
  }

  await session.bindExtensions({
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(),
      newSession: async (options) => ({ cancelled: !(await session.newSession(options)) }),
      fork: async (entryId) => ({ cancelled: (await session.fork(entryId)).cancelled }),
      navigateTree: async (targetId, options) => ({
        cancelled: (
          await session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label,
          })
        ).cancelled,
      }),
      switchSession: async (sessionPath) => ({ cancelled: !(await session.switchSession(sessionPath)) }),
      reload: async () => { await session.reload() },
    },
    onError: (err) => {
      output({ type: 'extension_error', extensionPath: err.extensionPath, event: err.event, error: err.error })
    },
  })

  session.subscribe((event: unknown) => output(event))

  const handleCommand = async (command: any) => {
    const id = command?.id
    const type = String(command?.type || 'unknown')

    switch (type) {
      case 'prompt':
        startTurnTask(String(command.requestTag || ''), async () => {
          await session.prompt(command.message, {
            images: command.images,
            streamingBehavior: command.streamingBehavior,
            source: 'rpc' as any,
          })
        })
        return done(id, 'prompt')

      case 'interrupt_prompt':
        startInterruptTurnTask(String(command.requestTag || ''), async () => {
          await session.prompt(command.message, {
            images: command.images,
            source: 'rpc' as any,
          })
        })
        return done(id, 'interrupt_prompt')

      case 'steer': return run(id, type, () => session.steer(command.message, command.images))
      case 'follow_up': return run(id, type, () => session.followUp(command.message, command.images))
      case 'abort': return run(id, type, () => session.abort())
      case 'get_state': return done(id, type, getSessionState(session))
      case 'cycle_model': return run(id, type, () => session.cycleModel(), (value) => value ?? null)
      case 'get_available_models': return run(id, type, () => session.modelRegistry.getAvailable(), (models) => ({ models }))
      case 'get_oauth_state': return done(id, type, getOAuthState(session))
      case 'set_thinking_level': return run(id, type, () => session.setThinkingLevel(command.level))
      case 'cycle_thinking_level': return run(id, type, () => session.cycleThinkingLevel(), (level) => (level ? { level } : null))
      case 'set_steering_mode': return run(id, type, () => session.setSteeringMode(command.mode))
      case 'set_follow_up_mode': return run(id, type, () => session.setFollowUpMode(command.mode))
      case 'compact': return run(id, type, () => session.compact(command.customInstructions))
      case 'set_auto_compaction': return run(id, type, () => session.setAutoCompactionEnabled(Boolean(command.enabled)))
      case 'set_auto_retry': return run(id, type, () => session.setAutoRetryEnabled(Boolean(command.enabled)))
      case 'abort_retry': return run(id, type, () => session.abortRetry())
      case 'bash': return run(id, type, () => session.executeBash(command.command))
      case 'abort_bash': return run(id, type, () => session.abortBash())
      case 'get_session_stats': return done(id, type, session.getSessionStats())
      case 'get_session_entries': return done(id, type, { entries: session.sessionManager.getEntries() })
      case 'get_session_tree': return done(id, type, { tree: session.sessionManager.getTree(), leafId: session.sessionManager.getLeafId() })
      case 'set_entry_label':
        return run(id, type, () => session.sessionManager.appendLabelChange(command.entryId, command.label?.trim() || undefined))
      case 'navigate_tree':
        return run(id, type, () => session.navigateTree(command.targetId, {
          summarize: command.summarize,
          customInstructions: command.customInstructions,
          replaceInstructions: command.replaceInstructions,
          label: command.label,
        }))
      case 'export_html': return run(id, type, () => session.exportToHtml(command.outputPath), (path) => ({ path }))
      case 'export_jsonl': return done(id, type, { path: session.exportToJsonl(command.outputPath) })
      case 'import_jsonl': return run(id, type, () => session.importFromJsonl(command.inputPath), (value) => ({ cancelled: !value }))
      case 'get_fork_messages': return done(id, type, { messages: session.getUserMessagesForForking() })
      case 'get_last_assistant_text': return done(id, type, { text: session.getLastAssistantText() })
      case 'get_messages': return done(id, type, { messages: session.messages })
      case 'get_commands': return done(id, type, { commands: getSlashCommands(session, builtinSlashCommands) })
      case 'run_command':
        return run(id, type, () => runBuiltinCommand(session, String(command.commandLine || ''), { SessionManager }), (value) => value)

      case 'new_session':
        return run(id, type, () => session.newSession(command.parentSession ? { parentSession: command.parentSession } : undefined), (value) => ({ cancelled: !value }))

      case 'switch_session':
        return run(id, type, () => session.switchSession(command.sessionPath), (value) => ({ cancelled: !value }))

      case 'fork':
        return run(id, type, () => session.fork(command.entryId), (value) => ({ text: value.selectedText, cancelled: value.cancelled }))

      case 'list_sessions': {
        const scope = command.scope === 'all' ? 'all' : 'cwd'
        const sessions = scope === 'all'
          ? await SessionManager.listAll()
          : await SessionManager.list(session.sessionManager.getCwd(), session.sessionManager.getSessionDir())
        return done(id, type, { sessions })
      }

      case 'set_model': {
        const models = await session.modelRegistry.getAvailable()
        const model = models.find((m: any) => m.provider === command.provider && m.id === command.modelId)
        if (!model) throw new Error(`Model not found: ${command.provider}/${command.modelId}`)
        await session.setModel(model)
        return done(id, type, model)
      }

      case 'rename_session': {
        const name = String(command.name || '').trim()
        if (!name) throw new Error('Session name cannot be empty')
        const manager = SessionManager.open(command.sessionPath)
        manager.appendSessionInfo(name)
        return done(id, type)
      }

      case 'set_session_name': {
        const name = String(command.name || '').trim()
        if (!name) throw new Error('Session name cannot be empty')
        session.setSessionName(name)
        return done(id, type)
      }

      case 'oauth_login_start': {
        const providerId = String(command.providerId || '').trim()
        if (!providerId) throw new Error('providerId is required')
        const loginId = `login_${++loginSeq}`
        const abort = new AbortController()
        activeLogins.set(loginId, { abort, waits: new Map() })
        ;(async () => {
          try {
            await session.modelRegistry.authStorage.login(providerId, {
              onAuth: (info: { url: string; instructions?: string }) => {
                emitLoginEvent(loginId, 'auth', { url: info.url, instructions: info.instructions })
              },
              onPrompt: (prompt: { message: string; placeholder?: string }) => {
                return waitForLoginInput(loginId, 'prompt', { message: prompt.message, placeholder: prompt.placeholder })
              },
              onProgress: (message: string) => {
                emitLoginEvent(loginId, 'progress', { message })
              },
              onManualCodeInput: () => waitForLoginInput(loginId, 'manual_code'),
              signal: abort.signal,
            })
            session.modelRegistry.refresh()
            emitLoginEvent(loginId, 'complete', { success: true, state: getOAuthState(session) })
          } catch (error: any) {
            emitLoginEvent(loginId, 'complete', { success: false, error: String(error?.message || error || 'oauth_login_failed') })
          } finally {
            finishLogin(loginId)
          }
        })().catch(() => {})
        return done(id, type, { loginId })
      }

      case 'oauth_login_respond': {
        const login = ensureLogin(String(command.loginId || ''))
        const requestId = String(command.requestId || '')
        const pending = login.waits.get(requestId)
        if (!pending) throw new Error(`Unknown OAuth login request: ${requestId}`)
        login.waits.delete(requestId)
        pending.resolve(String(command.value || ''))
        return done(id, type)
      }

      case 'oauth_login_cancel': {
        const loginId = String(command.loginId || '')
        const login = ensureLogin(loginId)
        login.abort.abort()
        finishLogin(loginId)
        return done(id, type)
      }

      case 'oauth_logout': {
        const providerId = String(command.providerId || '').trim()
        if (!providerId) throw new Error('providerId is required')
        session.modelRegistry.authStorage.logout(providerId)
        session.modelRegistry.refresh()
        return done(id, type, getOAuthState(session))
      }

      default:
        throw new Error(`Unknown command: ${type}`)
    }
  }

  const state = { buffer: '' }
  process.stdin.on('data', (chunk) => {
    parseJsonl(String(chunk), state, async (line) => {
      let command: any
      try {
        command = JSON.parse(line)
      } catch (error) {
        output(fail(undefined, 'parse', error))
        return
      }

      try {
        const reply = await handleCommand(command)
        if (reply) output(reply)
      } catch (error) {
        output(fail(command?.id, command?.type || 'unknown', error))
      }
    })
  })

  await new Promise<never>(() => {})
}

export async function startWorker(options: { additionalExtensionPaths?: string[] } = {}) {
  const sessionManagerModule = await loadRinSessionManagerModule()
  const { session } = await createConfiguredAgentSession({
    additionalExtensionPaths: options.additionalExtensionPaths,
  })
  await runCustomRpcMode(session, {
    SessionManager: sessionManagerModule.SessionManager,
    builtinSlashCommands: BUILTIN_SLASH_COMMANDS,
  })
}

async function main() {
  await startWorker()
}

const isDirectEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectEntry) {
  main().catch((error: any) => {
    const message = String(error && error.message ? error.message : error || 'rin_worker_failed')
    console.error(message)
    process.exit(1)
  })
}
