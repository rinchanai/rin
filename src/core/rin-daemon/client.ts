import net from "node:net";

import { defaultDaemonSocketPath, safeString } from "../rin-lib/common.js";

function parseJsonLine(buffer: string) {
  const idx = buffer.indexOf("\n");
  if (idx < 0) return null;
  let line = buffer.slice(0, idx);
  if (line.endsWith("\r")) line = line.slice(0, -1);
  return { line, rest: buffer.slice(idx + 1) };
}

export async function requestDaemonCommand(
  command: Record<string, any>,
  options: { socketPath?: string; timeoutMs?: number } = {},
) {
  const socketPath =
    safeString(options.socketPath).trim() || defaultDaemonSocketPath();
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 30_000));
  const id =
    safeString(command?.id).trim() ||
    `daemon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return await new Promise<any>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let buffer = "";
    const finish = (error?: unknown, value?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `daemon_timeout:${safeString(command?.type).trim() || "unknown"}`,
          ),
        ),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const parsed = parseJsonLine(buffer);
        if (!parsed) return;
        buffer = parsed.rest;
        if (!parsed.line.trim()) continue;
        let payload: any;
        try {
          payload = JSON.parse(parsed.line);
        } catch {
          finish(new Error("daemon_invalid_json"));
          return;
        }
        if (payload?.type !== "response" || payload?.id !== id) continue;
        if (payload?.success === false) {
          finish(new Error(String(payload?.error || "daemon_request_failed")));
          return;
        }
        finish(undefined, payload?.data ?? payload);
        return;
      }
    });
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify({ ...command, id })}\n`);
      } catch (error) {
        finish(error);
      }
    });
    socket.connect({ path: socketPath });
  });
}
