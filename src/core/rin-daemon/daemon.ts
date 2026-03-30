#!/usr/bin/env node
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { defaultDaemonSocketPath, safeString } from '../rin-lib/common.js'
import { loadRinSessionManagerModule } from '../rin-lib/loader.js'
import { emptySessionState, response } from '../rin-lib/rpc.js'
import { resolveRuntimeProfile } from '../rin-lib/runtime.js'
import { ConnectionState, WorkerPool } from './worker-pool.js'

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeLine(socket: net.Socket, payload: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`)
}

export async function startDaemon(options: { socketPath?: string; workerPath?: string } = {}) {
  const socketPath = options.socketPath || process.argv[2] || defaultDaemonSocketPath()
  const workerPath = options.workerPath || process.env.RIN_WORKER_PATH || path.join(path.dirname(new URL(import.meta.url).pathname), 'worker.js')
  const runtime = resolveRuntimeProfile()
  const sessionManagerModulePromise = loadRinSessionManagerModule()
  const maxWorkers = Math.max(1, Number(process.env.RIN_DAEMON_MAX_WORKERS || 8))
  const idleTtlMs = Math.max(60_000, Number(process.env.RIN_DAEMON_IDLE_TTL_MS || 15 * 60_000))
  const workerPool = new WorkerPool({
    workerPath,
    cwd: runtime.cwd,
    maxWorkers,
    idleTtlMs,
    onWorkerSpawn: (requester, worker) => {
      if (requester) writeLine(requester.socket, { type: 'ui', name: 'worker_spawned', payload: { pid: worker.child.pid ?? null } })
    },
  })

  try { fs.rmSync(socketPath, { force: true }) } catch {}
  ensureDir(path.dirname(socketPath))

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
      workerPool.requestWorker(workerPool.getCatalogWorker(), connection, command, false)
      return true
    }
    if (type === 'get_available_models' && !connection.attachedWorker) {
      workerPool.requestWorker(workerPool.getCatalogWorker(), connection, command, false)
      return true
    }
    if (type === 'get_oauth_state' && !connection.attachedWorker) {
      workerPool.requestWorker(workerPool.getCatalogWorker(), connection, command, false)
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
      workerPool.detachWorker(connection)
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
        ...workerPool.getStatusSnapshot(),
        maxWorkers,
        idleTtlMs,
      }))
      return true
    }
    return false
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
            workerPool.evictDetachedWorkers()
            return
          }

          const worker = workerPool.resolveWorkerForCommand(connection, command)
          if (!worker) {
            writeLine(socket, response(command?.id, String(command?.type || 'unknown'), false, 'rin_no_attached_session'))
            return
          }

          workerPool.forwardToWorker(connection, worker, command)
          workerPool.evictDetachedWorkers()
        })().catch((error) => {
          writeLine(socket, response(undefined, 'unknown', false, error))
        })
      }
    })

    const cleanup = () => {
      workerPool.detachWorker(connection)
      workerPool.evictDetachedWorkers()
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })

  server.listen(socketPath, () => {
    console.log(`rin daemon listening on ${socketPath}`)
  })

  const shutdown = async () => {
    workerPool.destroyAll()
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
