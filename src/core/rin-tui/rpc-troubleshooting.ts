export const RPC_TROUBLESHOOTING_HINT =
  "Try `rin doctor` and `rin --std` to troubleshoot.";

function isRpcStartupSocketError(message: string) {
  return /connect (?:ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)\b|socket hang up|write EPIPE/.test(
    message,
  );
}

export function describeRpcStartupError(error: unknown) {
  const message = String((error as any)?.message || error || "rin_tui_failed");
  if (!isRpcStartupSocketError(message)) return message;
  return `${message}. ${RPC_TROUBLESHOOTING_HINT}`;
}
