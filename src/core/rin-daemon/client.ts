import net from "node:net";

import {
  defaultDaemonSocketPath,
  parseJsonl,
  safeString,
} from "../rin-lib/common.js";

function resolveDaemonSocketPath(socketPath?: string) {
  return safeString(socketPath).trim() || defaultDaemonSocketPath();
}

export async function canConnectDaemonSocket(
  socketPath?: string,
  timeoutMs = 500,
) {
  const resolvedSocketPath = resolveDaemonSocketPath(socketPath);
  const timeout = Math.max(1, Number(timeoutMs || 500));
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeout);
    socket.once("error", () => finish(false));
    socket.once("connect", () => finish(true));
    socket.connect({ path: resolvedSocketPath });
  });
}

export async function requestDaemonCommand(
  command: Record<string, any>,
  options: { socketPath?: string; timeoutMs?: number } = {},
) {
  const socketPath = resolveDaemonSocketPath(options.socketPath);
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 30_000));
  const id =
    safeString(command?.id).trim() ||
    `daemon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return await new Promise<any>((resolve, reject) => {
    const socket = new net.Socket();
    const state = { buffer: "" };
    let settled = false;
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
      parseJsonl(String(chunk), state, (line) => {
        let payload: any;
        try {
          payload = JSON.parse(line);
        } catch {
          finish(new Error("daemon_invalid_json"));
          return;
        }
        if (payload?.type !== "response" || payload?.id !== id) return;
        if (payload?.success === false) {
          finish(new Error(String(payload?.error || "daemon_request_failed")));
          return;
        }
        finish(undefined, payload?.data ?? payload);
      });
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
