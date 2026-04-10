import net from "node:net";
import path from "node:path";

import type { ChatOutboxPayload } from "../rin-lib/chat-outbox.js";
import { safeString } from "./chat-helpers.js";

export type KoishiRpcCommand =
  | { type: "send_chat"; payload: ChatOutboxPayload }
  | {
      type: "run_chat_turn";
      payload: {
        chatKey?: string;
        controllerKey?: string;
        text: string;
        sessionFile?: string;
      };
    };

function parseJsonLine(buffer: string) {
  const idx = buffer.indexOf("\n");
  if (idx < 0) return null;
  let line = buffer.slice(0, idx);
  if (line.endsWith("\r")) line = line.slice(0, -1);
  return { line, rest: buffer.slice(idx + 1) };
}

export function koishiRpcSocketPath(agentDir: string) {
  return path.join(
    path.resolve(agentDir),
    "data",
    "koishi-sidecar",
    "rpc.sock",
  );
}

export async function requestKoishiRpc(
  agentDir: string,
  command: Record<string, any>,
  timeoutMs = 30_000,
) {
  const socketPath = koishiRpcSocketPath(agentDir);
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
            `koishi_rpc_timeout:${safeString(command?.type).trim() || "unknown"}`,
          ),
        ),
      Math.max(1, timeoutMs),
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
          finish(new Error("koishi_rpc_invalid_json"));
          return;
        }
        if (payload?.success === false) {
          finish(new Error(String(payload?.error || "koishi_rpc_failed")));
          return;
        }
        finish(undefined, payload?.data ?? payload);
        return;
      }
    });
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify(command)}\n`);
      } catch (error) {
        finish(error);
      }
    });
    socket.connect({ path: socketPath });
  });
}

export async function deliverKoishiRpcPayload(
  agentDir: string,
  payload: ChatOutboxPayload,
  timeoutMs = 30_000,
) {
  return await requestKoishiRpc(
    agentDir,
    {
      type: "send_chat",
      payload,
    },
    timeoutMs,
  );
}
