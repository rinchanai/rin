import type { AgentEvent } from "@mariozechner/pi-agent-core";

import {
  createInterruptedToolResultPayload,
  DAEMON_RESTART_OR_DISCONNECT_REASON,
} from "../rin-lib/interruption.js";
import {
  emitConnectionLost,
  queueOfflineOperation,
  type PendingRpcOperation,
} from "./reconnect.js";

export function clientIsConnected(client: any) {
  return typeof client?.isConnected === "function"
    ? Boolean(client.isConnected())
    : true;
}

export async function waitForDaemonAvailable(session: any) {
  if (clientIsConnected(session.client)) return;
  if (session.waitForDaemonPromise) return await session.waitForDaemonPromise;
  session.emitEvent({
    type: "status",
    level: "warning",
    text: "Waiting daemon...",
  } as any);
  session.waitForDaemonHintTimer = setTimeout(() => {
    session.waitForDaemonHintTimer = null;
    session.emitEvent({
      type: "status",
      level: "warning",
      text: "Daemon is still unavailable after 30s. Try `rin doctor` and `rin --std` to troubleshoot.",
    } as any);
  }, 30000);
  ensureReconnectLoop(session);
  session.waitForDaemonPromise = (async () => {
    while (!session.disposed) {
      if (clientIsConnected(session.client)) return;
      try {
        await session.client.connect();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw new Error("rin_tui_disposed");
  })().finally(() => {
    session.clearWaitingDaemonState();
  });
  return await session.waitForDaemonPromise;
}

export function queueRuntimeOfflineOperation(
  session: any,
  operation: PendingRpcOperation,
) {
  queueOfflineOperation(session, operation);
}

export async function sendOrQueueOperation(
  session: any,
  operation: PendingRpcOperation,
  refreshAllFlags: { messages?: boolean; models?: boolean; session?: boolean },
) {
  if (!clientIsConnected(session.client)) {
    queueRuntimeOfflineOperation(session, operation);
    return;
  }

  const sendOperation = async () => {
    await session.ensureRemoteSession();
    session.activeTurn = operation;
    session.syncStreamingState();
    await session.call(operation.mode, {
      message: operation.message,
      images: operation.images,
      source: operation.source,
      requestTag: operation.requestTag,
    });
  };

  try {
    await sendOperation();
  } catch (error: any) {
    const message = String(error?.message || error || "");
    if (/rin_tui_not_connected|rin_disconnected/.test(message)) {
      queueRuntimeOfflineOperation(session, operation);
      return;
    }
    if (/rin_no_attached_session/.test(message) && session.sessionFile) {
      await session.call("switch_session", {
        sessionPath: session.sessionFile,
      });
      await session.refreshState(refreshAllFlags);
      await sendOperation();
      return;
    }
    throw error;
  }
}

export function emitInterruptedToolExecutionEnds(session: any) {
  const lastMessage = Array.isArray(session.messages)
    ? session.messages[session.messages.length - 1]
    : null;
  if (!lastMessage || lastMessage.role !== "assistant") return;
  const toolCalls: any[] = Array.isArray(lastMessage.content)
    ? lastMessage.content.filter((item: any) => item?.type === "toolCall")
    : [];
  for (const toolCall of toolCalls) {
    session.emitEvent({
      type: "tool_execution_end",
      toolCallId: String(toolCall?.id || ""),
      toolName: String(toolCall?.name || ""),
      result: createInterruptedToolResultPayload(),
      isError: true,
    } as any);
  }
}

export function handleRuntimeConnectionLost(session: any) {
  const interruptedTurn = Boolean(
    session.isStreaming || session.remoteTurnRunning || session.activeTurn,
  );
  session.setRpcConnected(false);
  if (interruptedTurn) {
    emitInterruptedToolExecutionEnds(session);
    session.emitEvent({
      type: "agent_end",
      messages: session.messages,
      interrupted: true,
      reason: DAEMON_RESTART_OR_DISCONNECT_REASON,
    } as AgentEvent);
  }
  emitConnectionLost(session);
}

export function ensureReconnectLoop(session: any) {
  if (session.reconnecting || session.disposed) return;
  session.reconnecting = true;
  const tick = async () => {
    if (session.disposed) return;
    try {
      await session.client.connect();
    } catch {
      session.reconnectTimer = setTimeout(() => {
        void tick();
      }, 1000);
    }
  };
  void tick();
}

export async function handleRuntimeConnectionRestored(
  session: any,
  refreshSessionFlags: {
    messages?: boolean;
    models?: boolean;
    session?: boolean;
  },
  refreshMessagesAndSessionFlags: {
    messages?: boolean;
    models?: boolean;
    session?: boolean;
  },
) {
  if (session.disposed) return;
  if (session.restorePromise) return await session.restorePromise;
  session.restorePromise = (async () => {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
    session.setRpcConnected(true);
    try {
      if (session.sessionFile) {
        await session.call("switch_session", {
          sessionPath: session.sessionFile,
        });
      } else if (session.sessionId) {
        await session.call("attach_session", { sessionId: session.sessionId });
      }
      await session.refreshState(refreshSessionFlags).catch(() => {});
      void session.queueRefreshState(refreshMessagesAndSessionFlags);
      const queued = [...session.queuedOfflineOps];
      session.queuedOfflineOps = [];
      for (const operation of queued) {
        await session.sendOrQueue(operation);
      }
    } finally {
      session.reconnecting = false;
    }
  })().finally(() => {
    session.restorePromise = null;
  });
  return await session.restorePromise;
}
