export type PendingRpcOperation = {
  mode: "prompt" | "interrupt_prompt" | "steer" | "follow_up";
  message: string;
  images?: any[];
  source?: string;
  requestTag?: string;
};

export function queueOfflineOperation(
  target: {
    queuedOfflineOps: PendingRpcOperation[];
    ensureReconnectLoop: () => void;
  },
  operation: PendingRpcOperation,
) {
  target.queuedOfflineOps.push(operation);
  target.ensureReconnectLoop();
}

export function emitConnectionLost(target: {
  disposed: boolean;
  ensureReconnectLoop: () => void;
}) {
  if (target.disposed) return;
  target.ensureReconnectLoop();
}
