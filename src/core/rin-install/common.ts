import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function runCommand(command: string, args: string[], options: any = {}) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`terminated:${signal}`));
      resolve(code ?? 0);
    });
  });
}

export function detectCurrentUser() {
  const candidates = [
    process.env.SUDO_USER,
    process.env.LOGNAME,
    process.env.USER,
    (() => {
      try {
        return os.userInfo().username;
      } catch {
        return "";
      }
    })(),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return candidates[0] || "unknown";
}

export function repoRootFromHere() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
}
