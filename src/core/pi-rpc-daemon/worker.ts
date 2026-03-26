#!/usr/bin/env node
import { parseJsonl } from '../pi-rpc/common.js'
import { loadPiRpcSessionManagerModule } from '../pi-rpc/pi-rpc-loader.js'
import { createConfiguredAgentSession } from '../pi-session-factory.js'

function writeJsonLine(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function response(id: string | undefined, command: string, success: boolean, payload?: unknown) {
  return success
    ? payload === undefined
      ? { id, type: 'response', command, success: true }
      : { id, type: 'response', command, success: true, data: payload }
    : { id, type: 'response', command, success: false, error: String((payload as any)?.message || payload || 'pi_rpc_request_failed') }
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

function getSlashCommands(session: any) {
  const commands: any[] = []

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

async function runCustomRpcMode(session: any, deps: { SessionManager: any }) {
  const { SessionManager } = deps
  const output = (obj: unknown) => writeJsonLine(obj)
  const done = (id: string | undefined, type: string, value?: unknown) => ok(id, type, value)
  const run = async (id: string | undefined, type: string, fn: () => any, map?: (value: any) => any) => {
    const value = await fn()
    return done(id, type, map ? map(value) : value)
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
        session.prompt(command.message, {
          images: command.images,
          streamingBehavior: command.streamingBehavior,
          source: 'rpc' as any,
        }).catch((error: unknown) => output(fail(id, 'prompt', error)))
        return done(id, 'prompt')

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
      case 'get_commands': return done(id, type, { commands: getSlashCommands(session) })

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
  const sessionManagerModule = await loadPiRpcSessionManagerModule()
  const { session } = await createConfiguredAgentSession({
    additionalExtensionPaths: options.additionalExtensionPaths,
  })
  await runCustomRpcMode(session, { SessionManager: sessionManagerModule.SessionManager })
}

async function main() {
  await startWorker()
}

main().catch((error: any) => {
  const message = String(error && error.message ? error.message : error || 'pi_rpc_worker_failed')
  console.error(message)
  process.exit(1)
})
