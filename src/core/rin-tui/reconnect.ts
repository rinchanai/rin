export type PendingRpcOperation = {
  mode: 'prompt' | 'interrupt_prompt' | 'steer' | 'follow_up'
  message: string
  images?: any[]
  source?: string
  requestTag?: string
}

export function queueOfflineOperation(target: {
  queuedOfflineOps: PendingRpcOperation[]
  emitEvent: (event: any) => void
  ensureReconnectLoop: () => void
}, operation: PendingRpcOperation) {
  target.queuedOfflineOps.push(operation)
  target.emitEvent({
    type: 'rin_status',
    phase: 'update',
    message: 'Waiting daemon...',
    statusText: `Queued message while daemon is offline (${target.queuedOfflineOps.length} queued)`,
  } as any)
  target.ensureReconnectLoop()
}

export function emitConnectionLost(target: {
  disposed: boolean
  activeTurn: PendingRpcOperation | null
  emitEvent: (event: any) => void
  ensureReconnectLoop: () => void
}) {
  if (target.disposed) return
  target.emitEvent({
    type: 'rin_status',
    phase: 'update',
    message: 'Waiting daemon...',
    statusText: target.activeTurn
      ? 'Connection lost while processing. Will resume after daemon returns.'
      : 'Daemon disconnected. New messages will be queued until it returns.',
  } as any)
  target.ensureReconnectLoop()
}
