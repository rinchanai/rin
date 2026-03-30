#!/usr/bin/env node
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { defaultDaemonSocketPath, parseJsonl, safeString } from '../rin-lib/common.js'
import { loadRinSessionManagerModule } from '../rin-lib/loader.js'
import { resolveRuntimeProfile } from '../rin-lib/runtime.js'

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

type ConnectionState = {
  socket: net.Socket
  clientBuffer: string
  attachedWorker?: WorkerHandle
}

type WorkerHandle = {
  id: string
  child: ReturnType<typeof spawn>
  stdoutBuffer: { buffer: string }
  stderrBuffer: { buffer: string }
  connections: Set<ConnectionState>
  pendingResponses: Map<string, ConnectionState>
  sessionFile?: string
  sessionId?: string
  isStreaming: boolean
  isCompacting: boolean
  lastUsedAt: number
  keepAliveUntil: number
}

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

function writeLine(socket: net.Socket, payload: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`)
}

function response(id: string | undefined, command: string, success: boolean, payload?: unknown) {
  return success
    ? payload === undefined
      ? { id, type: 'response', command, success: true }
      : { id, type: 'response', command, success: true, data: payload }
    : { id, type: 'response', command, success: false, error: String((payload as any)?.message || payload || 'rin_request_failed') }
}

function emptySessionState() {
  return {
    model: null,
    thinkingLevel: 'medium',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    sessionFile: undefined,
    sessionId: '',
    sessionName: undefined,
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  }
}

function isSessionScopedCommand(type: string) {
  return new Set([
    'prompt',
    'interrupt_prompt',
    'steer',
    'follow_up',
    'abort',
    'get_state',
    'cycle_model',
    'get_available_models',
    'get_oauth_state',
    'set_thinking_level',
    'cycle_thinking_level',
    'set_steering_mode',
    'set_follow_up_mode',
    'compact',
    'set_auto_compaction',
    'set_auto_retry',
    'abort_retry',
    'bash',
    'abort_bash',
    'get_session_stats',
    'get_session_entries',
    'get_session_tree',
    'set_entry_label',
    'navigate_tree',
    'export_html',
    'export_jsonl',
    'import_jsonl',
    'get_fork_messages',
    'get_last_assistant_text',
    'get_messages',
    'run_command',
    'fork',
    'set_model',
    'set_session_name',
    'oauth_login_start',
    'oauth_login_respond',
    'oauth_login_cancel',
    'oauth_logout',
    'reload',
  ]).has(type)
}

export async function startDaemon(options: { socketPath?: string; workerPath?: string } = {}) {
  const socketPath = options.socketPath || process.argv[2] || defaultDaemonSocketPath()
  const workerPath = options.workerPath || process.env.RIN_WORKER_PATH || path.join(path.dirname(new URL(import.meta.url).pathname), 'worker.js')
  const runtime = resolveRuntimeProfile()
  const sessionManagerModulePromise = loadRinSessionManagerModule()
  const workers = new Set<WorkerHandle>()
  const workersBySessionFile = new Map<string, WorkerHandle>()
  let catalogWorker: WorkerHandle | undefined
  const maxWorkers = Math.max(1, Number(process.env.RIN_DAEMON_MAX_WORKERS || 8))
  const idleTtlMs = Math.max(60_000, Number(process.env.RIN_DAEMON_IDLE_TTL_MS || 15 * 60_000))
  let workerSeq = 0

  try { fs.rmSync(socketPath, { force: true }) } catch {}
  ensureDir(path.dirname(socketPath))

  const detachWorker = (connection: ConnectionState) => {
    const worker = connection.attachedWorker
    if (!worker) return
    worker.connections.delete(connection)
    connection.attachedWorker = undefined
    worker.lastUsedAt = Date.now()
    worker.keepAliveUntil = Math.max(worker.keepAliveUntil, Date.now() + 10_000)
  }

  const destroyWorker = (worker: WorkerHandle) => {
    if (!workers.has(worker)) return
    workers.delete(worker)
    if (catalogWorker === worker) catalogWorker = undefined
    if (worker.sessionFile && workersBySessionFile.get(worker.sessionFile) === worker) {
      workersBySessionFile.delete(worker.sessionFile)
    }
    for (const connection of Array.from(worker.connections)) {
      if (connection.attachedWorker === worker) connection.attachedWorker = undefined
      worker.connections.delete(connection)
      writeLine(connection.socket, { type: 'worker_exit', code: null, signal: 'SIGTERM' })
    }
    try { worker.child.stdin.end() } catch {}
    try { worker.child.stdout.destroy() } catch {}
    try { worker.child.stderr.destroy() } catch {}
    try { worker.child.kill('SIGTERM') } catch {}
  }

  const evictDetachedWorkers = () => {
    const now = Date.now()
    const detached = Array.from(workers)
      .filter((worker) => worker.connections.size === 0 && !worker.isStreaming && !worker.isCompacting && now >= worker.keepAliveUntil)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)

    for (const worker of detached) {
      if (workers.size <= maxWorkers && now - worker.lastUsedAt < idleTtlMs) break
      destroyWorker(worker)
    }
  }

  const updateWorkerMetadata = (worker: WorkerHandle, payload: any) => {
    if (!payload || typeof payload !== 'object') return
    worker.lastUsedAt = Date.now()

    if (payload.type === 'response' && payload.command === 'get_state' && payload.success === true) {
      const data = payload.data || {}
      if (typeof data.sessionFile === 'string' && data.sessionFile) {
        if (worker.sessionFile && workersBySessionFile.get(worker.sessionFile) === worker) {
          workersBySessionFile.delete(worker.sessionFile)
        }
        worker.sessionFile = data.sessionFile
        workersBySessionFile.set(worker.sessionFile, worker)
      }
      worker.sessionId = typeof data.sessionId === 'string' ? data.sessionId : worker.sessionId
      worker.isStreaming = Boolean(data.isStreaming)
      worker.isCompacting = Boolean(data.isCompacting)
      return
    }

    if (payload.type === 'agent_start') {
      worker.isStreaming = true
      worker.keepAliveUntil = Math.max(worker.keepAliveUntil, Date.now() + 30_000)
    }
    if (payload.type === 'agent_end') {
      worker.isStreaming = false
      worker.keepAliveUntil = Math.max(worker.keepAliveUntil, Date.now() + 10_000)
    }
    if (payload.type === 'compaction_start') {
      worker.isCompacting = true
      worker.keepAliveUntil = Math.max(worker.keepAliveUntil, Date.now() + 30_000)
    }
    if (payload.type === 'compaction_end') {
      worker.isCompacting = false
      worker.keepAliveUntil = Math.max(worker.keepAliveUntil, Date.now() + 10_000)
    }
    if (payload.type === 'rpc_turn_event' && payload.event === 'complete' && typeof payload.sessionFile === 'string' && payload.sessionFile) {
      if (worker.sessionFile && workersBySessionFile.get(worker.sessionFile) === worker) {
        workersBySessionFile.delete(worker.sessionFile)
      }
      worker.sessionFile = payload.sessionFile
      workersBySessionFile.set(worker.sessionFile, worker)
    }
  }

  const createWorker = (requester?: ConnectionState) => {
    const child = spawn(process.execPath, [workerPath], {
      cwd: runtime.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    const worker: WorkerHandle = {
      id: `worker_${++workerSeq}`,
      child,
      stdoutBuffer: { buffer: '' },
      stderrBuffer: { buffer: '' },
      connections: new Set(),
      pendingResponses: new Map(),
      isStreaming: false,
      isCompacting: false,
      lastUsedAt: Date.now(),
      keepAliveUntil: Date.now(),
    }
    workers.add(worker)

    child.on('spawn', () => {
      if (requester) writeLine(requester.socket, { type: 'ui', name: 'worker_spawned', payload: { pid: child.pid ?? null } })
    })

    child.stdout.on('data', (chunk) => {
      parseJsonl(String(chunk), worker.stdoutBuffer, (line) => {
        let payload: any
        try { payload = JSON.parse(line) } catch {
          for (const connection of worker.connections) {
            if (!connection.socket.destroyed) connection.socket.write(`${line}\n`)
          }
          return
        }

        updateWorkerMetadata(worker, payload)

        if (payload?.type === 'response' && payload.id && worker.pendingResponses.has(String(payload.id))) {
          const connection = worker.pendingResponses.get(String(payload.id))!
          worker.pendingResponses.delete(String(payload.id))
          writeLine(connection.socket, payload)
          return
        }

        for (const connection of worker.connections) {
          writeLine(connection.socket, payload)
        }
      })
    })

    child.stderr.on('data', (chunk) => {
      parseJsonl(String(chunk), worker.stderrBuffer, (line) => {
        for (const connection of worker.connections) {
          writeLine(connection.socket, { type: 'stderr', line })
        }
      })
    })

    child.on('exit', (code, signal) => {
      if (worker.sessionFile && workersBySessionFile.get(worker.sessionFile) === worker) {
        workersBySessionFile.delete(worker.sessionFile)
      }
      workers.delete(worker)
      for (const connection of Array.from(worker.connections)) {
        if (connection.attachedWorker === worker) connection.attachedWorker = undefined
        writeLine(connection.socket, { type: 'worker_exit', code: code ?? null, signal: signal ?? null })
      }
      worker.connections.clear()
      worker.pendingResponses.clear()
    })

    return worker
  }

  const attachWorker = (connection: ConnectionState, worker: WorkerHandle) => {
    if (connection.attachedWorker === worker) return
    detachWorker(connection)
    connection.attachedWorker = worker
    worker.connections.add(connection)
    worker.lastUsedAt = Date.now()
  }

  const requestWorker = (worker: WorkerHandle, connection: ConnectionState, command: any, attach: boolean) => {
    if (attach) attachWorker(connection, worker)
    worker.lastUsedAt = Date.now()
    worker.keepAliveUntil = Math.max(worker.keepAliveUntil, Date.now() + 10_000)
    if (command?.id) worker.pendingResponses.set(String(command.id), connection)
    worker.child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  const forwardToWorker = (connection: ConnectionState, worker: WorkerHandle, command: any) => {
    requestWorker(worker, connection, command, true)
  }

  const getCatalogWorker = () => {
    if (!catalogWorker || !workers.has(catalogWorker)) {
      catalogWorker = createWorker()
    }
    return catalogWorker
  }

  const selfHandleCommand = async (connection: ConnectionState, command: any) => {
    const id = command?.id
    const type = String(command?.type || 'unknown')

    if (type === 'get_state' && !connection.attachedWorker) {
      writeLine(connection.socket, response(id, type, true, emptySessionState()))
      return true
    }
    if (type === 'get_messages' && !connection.attachedWorker) {
      writeLine(connection.socket, response(id, type, true, { messages: [] }))
      return true
    }
    if (type === 'get_session_entries' && !connection.attachedWorker) {
      writeLine(connection.socket, response(id, type, true, { entries: [] }))
      return true
    }
    if (type === 'get_session_tree' && !connection.attachedWorker) {
      writeLine(connection.socket, response(id, type, true, { tree: [], leafId: null }))
      return true
    }
    if (type === 'get_commands' && !connection.attachedWorker) {
      requestWorker(getCatalogWorker(), connection, command, false)
      return true
    }
    if (type === 'get_available_models' && !connection.attachedWorker) {
      requestWorker(getCatalogWorker(), connection, command, false)
      return true
    }
    if (type === 'get_oauth_state' && !connection.attachedWorker) {
      requestWorker(getCatalogWorker(), connection, command, false)
      return true
    }
    if (type === 'list_sessions') {
      const { SessionManager } = await sessionManagerModulePromise
      const scope = command.scope === 'all' ? 'all' : 'cwd'
      const sessions = scope === 'all'
        ? await SessionManager.listAll()
        : await SessionManager.list(runtime.cwd, path.join(runtime.agentDir, 'sessions', `--${runtime.cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`))
      writeLine(connection.socket, response(id, type, true, { sessions }))
      return true
    }
    if (type === 'detach_session') {
      detachWorker(connection)
      writeLine(connection.socket, response(id, type, true, emptySessionState()))
      return true
    }
    if (type === 'rename_session') {
      const { SessionManager } = await sessionManagerModulePromise
      const name = String(command.name || '').trim()
      if (!name) {
        writeLine(connection.socket, response(id, type, false, 'Session name cannot be empty'))
        return true
      }
      const manager = SessionManager.open(command.sessionPath)
      manager.appendSessionInfo(name)
      writeLine(connection.socket, response(id, type, true))
      return true
    }
    if (type === 'daemon_status') {
      writeLine(connection.socket, response(id, type, true, {
        socketPath,
        workerCount: workers.size,
        maxWorkers,
        idleTtlMs,
        catalogWorkerId: catalogWorker && workers.has(catalogWorker) ? catalogWorker.id : undefined,
        workers: Array.from(workers).map((worker) => ({
          id: worker.id,
          pid: worker.child.pid ?? null,
          sessionFile: worker.sessionFile,
          sessionId: worker.sessionId,
          attachedConnections: worker.connections.size,
          pendingResponses: worker.pendingResponses.size,
          isStreaming: worker.isStreaming,
          isCompacting: worker.isCompacting,
          lastUsedAt: worker.lastUsedAt,
          keepAliveUntil: worker.keepAliveUntil,
          role: catalogWorker === worker ? 'catalog' : 'session',
        })),
      }))
      return true
    }
    return false
  }

  const resolveWorkerForCommand = (connection: ConnectionState, command: any) => {
    const type = String(command?.type || 'unknown')

    if (type === 'new_session') {
      return createWorker(connection)
    }

    if (type === 'switch_session') {
      const sessionPath = typeof command?.sessionPath === 'string' ? command.sessionPath : ''
      if (sessionPath && workersBySessionFile.has(sessionPath)) {
        return workersBySessionFile.get(sessionPath)!
      }
      return createWorker(connection)
    }

    if (connection.attachedWorker) return connection.attachedWorker
    if (isSessionScopedCommand(type)) return undefined
    return undefined
  }

  const server = net.createServer((socket) => {
    const connection: ConnectionState = {
      socket,
      clientBuffer: '',
    }

    socket.on('data', (chunk) => {
      connection.clientBuffer += String(chunk)
      while (true) {
        const idx = connection.clientBuffer.indexOf('\n')
        if (idx < 0) break
        let line = connection.clientBuffer.slice(0, idx)
        connection.clientBuffer = connection.clientBuffer.slice(idx + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line.trim()) continue

        ;(async () => {
          let command: any
          try {
            command = JSON.parse(line)
          } catch {
            writeLine(socket, response(undefined, 'unknown', false, 'invalid_json'))
            return
          }

          if (await selfHandleCommand(connection, command)) {
            evictDetachedWorkers()
            return
          }

          const worker = resolveWorkerForCommand(connection, command)
          if (!worker) {
            writeLine(socket, response(command?.id, String(command?.type || 'unknown'), false, 'rin_no_attached_session'))
            return
          }

          forwardToWorker(connection, worker, command)
          evictDetachedWorkers()
        })().catch((error) => {
          writeLine(socket, response(undefined, 'unknown', false, error))
        })
      }
    })

    const cleanup = () => {
      detachWorker(connection)
      evictDetachedWorkers()
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })

  server.listen(socketPath, () => {
    console.log(`rin daemon listening on ${socketPath}`)
  })

  const shutdown = async () => {
    for (const worker of Array.from(workers)) {
      destroyWorker(worker)
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try { fs.rmSync(socketPath, { force: true }) } catch {}
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function main() {
  await startDaemon()
}

const isDirectEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectEntry) {
  main().catch((error: any) => {
    console.error(safeString(error && error.message ? error.message : error) || 'rin_daemon_failed')
    process.exit(1)
  })
}
