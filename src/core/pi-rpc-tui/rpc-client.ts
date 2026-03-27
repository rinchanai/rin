import net from 'node:net'

import { defaultDaemonSocketPath, parseJsonl } from '../pi-rpc-lib/common.js'
import type {
  FrontendAutocompleteItem,
  FrontendCommandItem,
  FrontendDialogSpec,
  FrontendModelItem,
  FrontendSessionItem,
  InteractiveFrontendEvent,
  InteractiveFrontendSurface,
} from './frontend-surface.js'

function toFrontendEvent(event: any): InteractiveFrontendEvent | null {
  if (!event || typeof event !== 'object') return null

  if (event.type === 'stderr') {
    return { type: 'status', level: 'warning', text: String(event.line || '') }
  }

  if (event.type === 'worker_exit') {
    return { type: 'status', level: 'error', text: `worker exited: code=${String(event.code)} signal=${String(event.signal)}` }
  }

  if (event.type === 'response') {
    return { type: 'ui', name: 'response', payload: event }
  }

  return { type: 'ui', name: String(event.type || 'event'), payload: event }
}

export class PiRpcDaemonFrontendClient implements InteractiveFrontendSurface {
  socketPath: string
  socket: net.Socket | null = null
  state = { buffer: '' }
  requestId = 0
  pending = new Map<string, { resolve: Function; reject: Function; timer: NodeJS.Timeout }>()
  listeners = new Set<(event: InteractiveFrontendEvent) => void>()

  constructor(socketPath = defaultDaemonSocketPath()) {
    this.socketPath = socketPath
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath)
      const onError = (error: Error) => {
        try { socket.destroy() } catch {}
        reject(error)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.removeListener('error', onError)
        this.socket = socket
        socket.on('data', (chunk) => this.handleChunk(String(chunk)))
        socket.on('close', () => this.handleDisconnect())
        socket.on('error', () => this.handleDisconnect())
        resolve()
      })
    })
  }

  async disconnect() {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    try { socket.end() } catch {}
    try { socket.destroy() } catch {}
    this.handleDisconnect()
  }

  subscribe(listener: (event: InteractiveFrontendEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async submit(text: string) {
    await this.send({ type: 'prompt', message: text })
  }

  async abort() {
    await this.send({ type: 'abort' })
  }

  async getAutocompleteItems(_input: string): Promise<FrontendAutocompleteItem[]> {
    const commands = await this.getCommands().catch(() => [])
    return commands.map((command) => ({
      id: command.id,
      label: command.name,
      insertText: command.name.startsWith('/') ? command.name : `/${command.name}`,
      detail: command.description,
      kind: 'command' as const,
    }))
  }

  async getCommands(): Promise<FrontendCommandItem[]> {
    const data = this.getData(await this.send({ type: 'get_commands' }))
    const commands = Array.isArray(data?.commands) ? data.commands : []
    return commands.map((command: any) => ({
      id: String(command.name || command.id || ''),
      name: String(command.name || ''),
      description: typeof command.description === 'string' ? command.description : undefined,
      category: typeof command.category === 'string' ? command.category : undefined,
    }))
  }

  async listSessions(): Promise<FrontendSessionItem[]> {
    return []
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.send({ type: 'switch_session', sessionPath: sessionId })
  }

  async listModels(): Promise<FrontendModelItem[]> {
    const data = this.getData(await this.send({ type: 'get_available_models' }))
    const models = Array.isArray(data?.models) ? data.models : []
    return models.map((model: any) => ({
      id: String(model.id || ''),
      label: String(model.label || model.id || ''),
      provider: typeof model.provider === 'string' ? model.provider : undefined,
      description: typeof model.description === 'string' ? model.description : undefined,
    }))
  }

  async openDialog(_id: string): Promise<FrontendDialogSpec | null> {
    return null
  }

  async respondDialog(_id: string, _payload: unknown): Promise<void> {}

  async send(command: any) {
    if (!this.socket || this.socket.destroyed) throw new Error('pi_rpc_tui_not_connected')
    const id = `req_${++this.requestId}`
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`pi_rpc_timeout:${String(command?.type || 'command')}`))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }

  private handleChunk(chunk: string) {
    parseJsonl(chunk, this.state, (line) => this.handleLine(line))
  }

  private handleLine(line: string) {
    let data: any
    try { data = JSON.parse(line) } catch { return }

    if (data?.type === 'response' && data.id && this.pending.has(data.id)) {
      const pending = this.pending.get(data.id)!
      this.pending.delete(data.id)
      clearTimeout(pending.timer)
      pending.resolve(data)
      return
    }

    const event = toFrontendEvent(data)
    if (!event) return
    for (const listener of this.listeners) {
      try { listener(event) } catch {}
    }
  }

  private handleDisconnect() {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      try { pending.reject(new Error(`pi_rpc_disconnected:${id}`)) } catch {}
    }
    this.pending.clear()
  }

  private getData(response: any) {
    if (!response || response.success !== true) {
      throw new Error(String(response?.error || 'pi_rpc_request_failed'))
    }
    return response.data
  }
}
