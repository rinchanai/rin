#!/usr/bin/env node
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { defaultDaemonSocketPath, parseJsonl, safeString } from '../pi-rpc/common.js'

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

async function main() {
  const socketPath = process.argv[2] || defaultDaemonSocketPath()
  const connections = new Set<{ socket: net.Socket; closeWorker: () => void }>()

  try { fs.rmSync(socketPath, { force: true }) } catch {}
  ensureDir(path.dirname(socketPath))

  const server = net.createServer((socket) => {
    let clientBuffer = ''
    let workerStdoutBuffer = { buffer: '' }
    let workerStderrBuffer = { buffer: '' }
    let worker: ReturnType<typeof spawn> | null = null

    const sendLine = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\n`)
    }

    const ensureWorker = () => {
      if (worker) return worker
      const workerPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'worker.js')
      worker = spawn(process.execPath, [workerPath], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      worker.on('spawn', () => {
        sendLine(JSON.stringify({ type: 'ui', name: 'worker_spawned', payload: { pid: worker?.pid ?? null } }))
      })
      worker.stdout.on('data', (chunk) => {
        parseJsonl(String(chunk), workerStdoutBuffer, (line) => {
          sendLine(line)
        })
      })
      worker.stderr.on('data', (chunk) => {
        parseJsonl(String(chunk), workerStderrBuffer, (line) => {
          sendLine(JSON.stringify({ type: 'stderr', line }))
        })
      })
      worker.on('exit', (code, signal) => {
        worker = null
        sendLine(JSON.stringify({ type: 'worker_exit', code: code ?? null, signal: signal ?? null }))
      })
      return worker
    }

    const closeWorker = () => {
      if (!worker) return
      try { worker.stdin.end() } catch {}
      try { worker.stdout.destroy() } catch {}
      try { worker.stderr.destroy() } catch {}
      try { worker.kill('SIGTERM') } catch {}
      worker = null
    }

    connections.add({ socket, closeWorker })

    socket.on('data', (chunk) => {
      clientBuffer += String(chunk)
      while (true) {
        const idx = clientBuffer.indexOf('\n')
        if (idx < 0) break
        let line = clientBuffer.slice(0, idx)
        clientBuffer = clientBuffer.slice(idx + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line.trim()) continue
        const currentWorker = ensureWorker()
        currentWorker.stdin.write(`${line}\n`)
      }
    })

    const cleanup = () => {
      closeWorker()
      for (const entry of Array.from(connections)) {
        if (entry.socket === socket) connections.delete(entry)
      }
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })

  server.listen(socketPath, () => {
    console.log(`pi rpc daemon listening on ${socketPath}`)
  })

  const shutdown = async () => {
    for (const entry of Array.from(connections)) {
      try { entry.closeWorker() } catch {}
    }
    connections.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try { fs.rmSync(socketPath, { force: true }) } catch {}
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: any) => {
  console.error(safeString(error && error.message ? error.message : error) || 'pi_rpc_daemon_failed')
  process.exit(1)
})
