export async function handleRpcSessionEvent(
  target: any,
  payload: any,
  refreshMessages: () => Promise<any>,
  refreshMessagesAndSession: () => Promise<any>,
) {
  if (!payload || typeof payload !== "object") return;
  const setRemoteTurnRunning = (running: boolean) => {
    if (typeof target.setRemoteTurnRunning === "function") {
      target.setRemoteTurnRunning(running);
    } else {
      target.isStreaming = running;
    }
  };
  if (payload.type === "agent_start") setRemoteTurnRunning(true);
  if (payload.type === "compaction_start") target.isCompacting = true;
  if (payload.type === "compaction_end") {
    target.isCompacting = false;
    void refreshMessagesAndSession();
  }
  if (payload.type === "auto_retry_start")
    target.retryAttempt = Number(payload.attempt || 1);
  if (payload.type === "auto_retry_end") target.retryAttempt = 0;
  if (payload.type === "agent_end") {
    setRemoteTurnRunning(false);
    target.activeTurn = null;
    void refreshMessagesAndSession();
  }
  if (
    payload.type === "message_end" ||
    payload.type === "tool_execution_end" ||
    payload.type === "compaction_message"
  ) {
    void refreshMessages();
  }
  target.emitEvent(payload);
}
