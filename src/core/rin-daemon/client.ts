import net from "node:net";

import {
  defaultDaemonSocketPath,
  parseJsonl,
  safeString,
} from "../rin-lib/common.js";

function resolveDaemonSocketPath(socketPath?: string) {
  return safeString(socketPath).trim() || defaultDaemonSocketPath();
}

function resolveTimeoutMs(timeoutMs: number | undefined, fallback: number) {
  return Math.max(1, Number(timeoutMs || fallback));
}

export function buildDaemonSocketProbeScript(
  socketPath?: string,
  timeoutMs = 500,
) {
  const resolvedSocketPath = resolveDaemonSocketPath(socketPath);
  const timeout = resolveTimeoutMs(timeoutMs, 500);
  return `const net=require('node:net');const s=net.createConnection({path:${JSON.stringify(resolvedSocketPath)}});let done=false;const finish=(ok)=>{if(done)return;done=true;try{s.destroy()}catch{};process.exit(ok?0:1)};s.once('connect',()=>finish(true));s.once('error',()=>finish(false));setTimeout(()=>finish(false),${timeout});`;
}

export function buildDaemonStatusScript(
  socketPath?: string,
  timeoutMs = 1500,
  requestId = "doctor_1",
) {
  const resolvedSocketPath = resolveDaemonSocketPath(socketPath);
  const timeout = resolveTimeoutMs(timeoutMs, 1500);
  const id = safeString(requestId).trim() || "doctor_1";
  return `const net=require('node:net');const socketPath=${JSON.stringify(resolvedSocketPath)};const socket=net.createConnection({path:socketPath});let buffer='';let settled=false;const finish=(value)=>{if(settled)return;settled=true;try{socket.destroy()}catch{};process.stdout.write(JSON.stringify(value===undefined?null:value));};socket.once('error',()=>finish(undefined));socket.on('data',(chunk)=>{buffer+=String(chunk);while(true){const idx=buffer.indexOf('\\n');if(idx<0)break;let line=buffer.slice(0,idx);buffer=buffer.slice(idx+1);if(line.endsWith('\\r'))line=line.slice(0,-1);if(!line.trim())continue;try{const payload=JSON.parse(line);if(payload?.type==='response'&&payload?.command==='daemon_status'&&payload?.id===${JSON.stringify(id)}){finish(payload.success===true?payload.data:undefined);return;}}catch{}}});socket.once('connect',()=>{socket.write(JSON.stringify({id:${JSON.stringify(id)},type:'daemon_status'})+'\\n');setTimeout(()=>finish(undefined),${timeout});});`;
}

export async function canConnectDaemonSocket(
  socketPath?: string,
  timeoutMs = 500,
) {
  const resolvedSocketPath = resolveDaemonSocketPath(socketPath);
  const timeout = resolveTimeoutMs(timeoutMs, 500);
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
  const timeoutMs = resolveTimeoutMs(options.timeoutMs, 30_000);
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
