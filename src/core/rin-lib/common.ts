import path from 'node:path'
import os from 'node:os'

export function safeString(value: unknown): string {
  if (value == null) return ''
  return String(value)
}

export function defaultDaemonSocketPath() {
  const fallbackRuntimeDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches')
    : path.join(os.homedir(), '.cache')
  const runtimeDir = safeString(process.env.XDG_RUNTIME_DIR).trim() || fallbackRuntimeDir
  return path.join(runtimeDir, 'rin-daemon', 'daemon.sock')
}

export function parseJsonl(chunk: string, state: { buffer: string }, onLine: (line: string) => void) {
  state.buffer += chunk
  while (true) {
    const idx = state.buffer.indexOf('\n')
    if (idx < 0) break
    let line = state.buffer.slice(0, idx)
    state.buffer = state.buffer.slice(idx + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line.trim()) continue
    onLine(line)
  }
}
