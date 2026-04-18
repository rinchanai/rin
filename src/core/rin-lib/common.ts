import path from "node:path";
import os from "node:os";
import { safeString } from "../text-utils.js";

export { safeString };

export function bridgeDaemonSocketPath(agentDir: string) {
  return path.join(agentDir, "data", "daemon", "bridge.sock");
}

export function defaultDaemonSocketPath() {
  const explicitSocketPath = safeString(
    process.env.RIN_DAEMON_SOCKET_PATH,
  ).trim();
  if (explicitSocketPath) return explicitSocketPath;

  if (process.platform === "linux") {
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (uid >= 0) {
      const runUserDir = path.join("/run/user", String(uid));
      if (os.platform() === "linux") {
        return path.join(runUserDir, "rin-daemon", "daemon.sock");
      }
    }
  }

  const fallbackRuntimeDir =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : path.join(os.homedir(), ".cache");
  const runtimeDir =
    safeString(process.env.XDG_RUNTIME_DIR).trim() || fallbackRuntimeDir;
  return path.join(runtimeDir, "rin-daemon", "daemon.sock");
}

export function parseJsonl(
  chunk: string,
  state: { buffer: string },
  onLine: (line: string) => void,
) {
  state.buffer += chunk;
  while (true) {
    const idx = state.buffer.indexOf("\n");
    if (idx < 0) break;
    let line = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    onLine(line);
  }
}
