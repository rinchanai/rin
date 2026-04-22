import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import * as pty from "node-pty";

export type HiddenSessionMode = "rpc" | "std";

export type HiddenSessionSpec = {
  name: string;
  mode: HiddenSessionMode;
  passthrough: string[];
  repoRoot: string;
  agentDir: string;
};

export type HiddenSessionState = {
  name: string;
  mode: HiddenSessionMode;
  pid: number;
  socketPath: string;
  statePath: string;
  createdAt: string;
  repoRoot: string;
  agentDir: string;
  passthrough: string[];
};

const HIDDEN_SESSION_STATE_DIR = "hidden-sessions";
const DETACH_CONTROL_CODE = 0x1d;

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

export function sanitizeHiddenSessionName(value: string) {
  const name = safeString(value).trim();
  if (!name) throw new Error("rin_hidden_session_name_required");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("rin_hidden_session_name_invalid");
  }
  return name;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeIfExists(filePath: string) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function currentSocketRuntimeRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "rin-hidden-session");
  }
  const runtimeDir = safeString(process.env.XDG_RUNTIME_DIR).trim();
  if (runtimeDir) return path.join(runtimeDir, "rin-hidden-session");
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid >= 0) return path.join(os.tmpdir(), `rin-hidden-session-${uid}`);
  return path.join(os.tmpdir(), "rin-hidden-session");
}

export function hiddenSessionStateRoot(agentDir: string) {
  return path.join(agentDir, "data", HIDDEN_SESSION_STATE_DIR);
}

export function hiddenSessionStatePath(agentDir: string, name: string) {
  return path.join(
    hiddenSessionStateRoot(agentDir),
    `${sanitizeHiddenSessionName(name)}.json`,
  );
}

export function hiddenSessionSocketPath(name: string) {
  return path.join(
    currentSocketRuntimeRoot(),
    `${sanitizeHiddenSessionName(name)}.sock`,
  );
}

function isProcessAlive(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readHiddenSessionState(agentDir: string, name: string) {
  return readJsonFile<HiddenSessionState | null>(
    hiddenSessionStatePath(agentDir, name),
    null,
  );
}

function cleanupHiddenSessionArtifacts(state: {
  agentDir?: string;
  name?: string;
  socketPath?: string;
  statePath?: string;
}) {
  const name = safeString(state.name).trim();
  const agentDir = safeString(state.agentDir).trim();
  const socketPath =
    safeString(state.socketPath).trim() || (name ? hiddenSessionSocketPath(name) : "");
  const statePath =
    safeString(state.statePath).trim() ||
    (agentDir && name ? hiddenSessionStatePath(agentDir, name) : "");
  if (socketPath) removeIfExists(socketPath);
  if (statePath) removeIfExists(statePath);
}

function isHiddenSessionStateUsable(state: HiddenSessionState | null | undefined) {
  if (!state) return false;
  return (
    isProcessAlive(Number(state.pid || 0)) &&
    Boolean(safeString(state.socketPath).trim()) &&
    fs.existsSync(safeString(state.socketPath).trim())
  );
}

export function listHiddenSessions(agentDir: string) {
  const root = hiddenSessionStateRoot(agentDir);
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(root)
      .filter((item) => item.endsWith(".json"))
      .map((item) => item.slice(0, -5))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [] as HiddenSessionState[];
  }
  const rows: HiddenSessionState[] = [];
  for (const name of names) {
    const state = readHiddenSessionState(agentDir, name);
    if (isHiddenSessionStateUsable(state)) {
      rows.push(state!);
      continue;
    }
    cleanupHiddenSessionArtifacts({
      agentDir,
      name,
      socketPath: safeString(state?.socketPath).trim(),
      statePath: safeString(state?.statePath).trim(),
    });
  }
  return rows;
}

function buildHiddenSessionHostState(spec: HiddenSessionSpec): HiddenSessionState {
  const name = sanitizeHiddenSessionName(spec.name);
  return {
    name,
    mode: spec.mode,
    pid: process.pid,
    socketPath: hiddenSessionSocketPath(name),
    statePath: hiddenSessionStatePath(spec.agentDir, name),
    createdAt: new Date().toISOString(),
    repoRoot: spec.repoRoot,
    agentDir: spec.agentDir,
    passthrough: [...(spec.passthrough || [])],
  };
}

async function waitForSocket(socketPath: string, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(socketPath);
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {}
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`rin_hidden_session_socket_timeout:${socketPath}`);
}

function hiddenSessionHostEntry(repoRoot: string) {
  return path.join(repoRoot, "dist", "app", "rin-hidden-session", "main.js");
}

async function spawnHiddenSessionHost(spec: HiddenSessionSpec) {
  const name = sanitizeHiddenSessionName(spec.name);
  cleanupHiddenSessionArtifacts({
    agentDir: spec.agentDir,
    name,
  });
  const child = spawn(
    process.execPath,
    [hiddenSessionHostEntry(spec.repoRoot), "host"],
    {
      cwd: spec.repoRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        RIN_HIDDEN_SESSION_SPEC: JSON.stringify({
          name,
          mode: spec.mode,
          passthrough: [...(spec.passthrough || [])],
          repoRoot: spec.repoRoot,
          agentDir: spec.agentDir,
        } satisfies HiddenSessionSpec),
      },
    },
  );
  child.unref();
  await waitForSocket(hiddenSessionSocketPath(name));
}

async function connectHiddenSessionSocket(socketPath: string) {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function encodeEvent(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

function decodeLineBuffer(
  buffer: string,
  onLine: (line: string) => void,
) {
  let next = buffer;
  while (true) {
    const idx = next.indexOf("\n");
    if (idx < 0) break;
    const line = next.slice(0, idx).trim();
    next = next.slice(idx + 1);
    if (line) onLine(line);
  }
  return next;
}

function currentTerminalSize() {
  return {
    cols: Number(process.stdout.columns || 80) || 80,
    rows: Number(process.stdout.rows || 24) || 24,
  };
}

function restoreTerminal(rawModeEnabled: boolean) {
  try {
    if (rawModeEnabled && process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {}
  try {
    process.stdin.pause();
  } catch {}
}

export async function attachHiddenSession(spec: HiddenSessionSpec) {
  const name = sanitizeHiddenSessionName(spec.name);
  let state = readHiddenSessionState(spec.agentDir, name);
  if (!isHiddenSessionStateUsable(state)) {
    await spawnHiddenSessionHost({
      ...spec,
      name,
    });
    state =
      readHiddenSessionState(spec.agentDir, name) ||
      ({
        name,
        mode: spec.mode,
        pid: -1,
        socketPath: hiddenSessionSocketPath(name),
        statePath: hiddenSessionStatePath(spec.agentDir, name),
        createdAt: new Date().toISOString(),
        repoRoot: spec.repoRoot,
        agentDir: spec.agentDir,
        passthrough: [...(spec.passthrough || [])],
      } satisfies HiddenSessionState);
  }
  if (!safeString(state?.socketPath).trim() || !fs.existsSync(state.socketPath)) {
    throw new Error(`rin_hidden_session_unavailable:${name}`);
  }

  const socket = await connectHiddenSessionSocket(state!.socketPath);
  let rawModeEnabled = false;
  let socketBuffer = "";
  let remoteExitCode = 0;
  let remoteExited = false;
  let finished = false;

  const finish = (code = 0) => {
    if (finished) return;
    finished = true;
    try {
      socket.destroy();
    } catch {}
    process.stdout.off("resize", onResize);
    process.stdin.off("data", onInput);
    process.stdin.off("end", onInputEnd);
    restoreTerminal(rawModeEnabled);
    process.exit(code);
  };

  const onResize = () => {
    const { cols, rows } = currentTerminalSize();
    socket.write(encodeEvent({ type: "resize", cols, rows }));
  };

  const onInput = (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (buffer.length === 1 && buffer[0] === DETACH_CONTROL_CODE) {
      socket.write(encodeEvent({ type: "detach" }));
      socket.end();
      return;
    }
    socket.write(
      encodeEvent({ type: "input", data: buffer.toString("utf8") }),
    );
  };

  const onInputEnd = () => {
    socket.write(encodeEvent({ type: "detach" }));
    socket.end();
  };

  socket.on("data", (chunk) => {
    socketBuffer = decodeLineBuffer(`${socketBuffer}${String(chunk)}`, (line) => {
      let event: any = null;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === "data") {
        if (event.data) process.stdout.write(String(event.data));
        return;
      }
      if (event?.type === "exit") {
        remoteExited = true;
        remoteExitCode = Number(event.exitCode || 0) || 0;
      }
    });
  });
  socket.once("error", (error) => {
    restoreTerminal(rawModeEnabled);
    console.error(String((error as any)?.message || error));
    finish(1);
  });
  socket.once("close", () => {
    finish(remoteExited ? remoteExitCode : 0);
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    rawModeEnabled = true;
  }
  process.stdin.resume();
  process.stdin.on("data", onInput);
  process.stdin.on("end", onInputEnd);
  process.stdout.on("resize", onResize);
  onResize();
}

export async function listHiddenSessionNames(agentDir: string) {
  return listHiddenSessions(agentDir).map((state) => state.name);
}

export async function runHiddenSessionList(agentDir: string) {
  const names = await listHiddenSessionNames(agentDir);
  if (names.length) process.stdout.write(`${names.join("\n")}\n`);
}

export async function runHiddenSessionHost(spec: HiddenSessionSpec) {
  const state = buildHiddenSessionHostState(spec);
  const socketPath = state.socketPath;
  ensureDir(path.dirname(socketPath));
  cleanupHiddenSessionArtifacts({
    agentDir: spec.agentDir,
    name: state.name,
    socketPath,
    statePath: state.statePath,
  });

  const modeArg = spec.mode === "std" ? "--std" : "--rpc";
  const tuiEntry = path.join(spec.repoRoot, "dist", "app", "rin-tui", "main.js");
  const ptyProcess = pty.spawn(process.execPath, [tuiEntry, modeArg, ...spec.passthrough], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: spec.repoRoot,
    env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
  });

  let activeSocket: net.Socket | null = null;
  let activeBuffer = "";
  let shuttingDown = false;
  const server = net.createServer((socket) => {
    if (activeSocket && activeSocket !== socket) {
      try {
        activeSocket.end();
      } catch {}
      try {
        activeSocket.destroy();
      } catch {}
    }
    activeSocket = socket;
    activeBuffer = "";
    socket.on("data", (chunk) => {
      activeBuffer = decodeLineBuffer(`${activeBuffer}${String(chunk)}`, (line) => {
        let event: any = null;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event?.type === "input" && typeof event.data === "string") {
          ptyProcess.write(event.data);
          return;
        }
        if (event?.type === "resize") {
          const cols = Math.max(20, Number(event.cols || 80) || 80);
          const rows = Math.max(5, Number(event.rows || 24) || 24);
          try {
            ptyProcess.resize(cols, rows);
          } catch {}
          return;
        }
        if (event?.type === "detach") {
          try {
            socket.end();
          } catch {}
        }
      });
    });
    socket.on("close", () => {
      if (activeSocket === socket) activeSocket = null;
    });
    socket.on("error", () => {
      if (activeSocket === socket) activeSocket = null;
    });
  });

  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      server.close();
    } catch {}
    try {
      activeSocket?.destroy();
    } catch {}
    cleanupHiddenSessionArtifacts({
      agentDir: spec.agentDir,
      name: state.name,
      socketPath,
      statePath: state.statePath,
    });
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  ptyProcess.onData((data) => {
    if (!activeSocket) return;
    activeSocket.write(encodeEvent({ type: "data", data }));
  });
  ptyProcess.onExit(({ exitCode, signal }) => {
    if (activeSocket && !activeSocket.destroyed) {
      activeSocket.write(
        encodeEvent({ type: "exit", exitCode, signal: signal || undefined }),
      );
      activeSocket.end();
    }
    cleanup();
    process.exit(Number(exitCode || 0) || 0);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  writeJsonFile(state.statePath, state);
}

export function parseHiddenSessionSpecFromEnv() {
  const raw = safeString(process.env.RIN_HIDDEN_SESSION_SPEC).trim();
  if (!raw) throw new Error("rin_hidden_session_spec_missing");
  const parsed = JSON.parse(raw) as HiddenSessionSpec;
  return {
    name: sanitizeHiddenSessionName(parsed.name),
    mode: parsed.mode === "std" ? "std" : "rpc",
    passthrough: Array.isArray(parsed.passthrough)
      ? parsed.passthrough.map((item) => safeString(item))
      : [],
    repoRoot: safeString(parsed.repoRoot).trim(),
    agentDir: safeString(parsed.agentDir).trim(),
  } satisfies HiddenSessionSpec;
}
