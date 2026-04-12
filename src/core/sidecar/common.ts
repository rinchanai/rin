import fs from "node:fs";
import path from "node:path";

import {
  ensurePrivateDir,
  readJsonFile,
  writeJsonAtomic,
} from "../platform/fs.js";
import { isPidAlive, sleep } from "../platform/process.js";

export async function acquireProcessLock(lockPath: string, timeoutMs = 20_000) {
  ensurePrivateDir(path.dirname(lockPath));
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, ts: Date.now() }),
      );
      try {
        fs.closeSync(fd);
      } catch {}
      return () => {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {}
      };
    } catch {
      let stale = false;
      try {
        const state = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (!isPidAlive(Number(state?.pid || 0))) stale = true;
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {}
        continue;
      }
      await sleep(100);
    }
  }
  throw new Error(`sidecar_lock_timeout:${lockPath}`);
}

export function listInstanceIds(instancesRoot: string) {
  try {
    return fs
      .readdirSync(instancesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [] as string[];
  }
}

export function readInstanceState<T>(statePath: string) {
  return readJsonFile<T | null>(statePath, null);
}

export function writeInstanceState(statePath: string, value: unknown) {
  writeJsonAtomic(statePath, value);
}
