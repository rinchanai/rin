import os from "node:os";
import path from "node:path";

import { getRuntimeSessionDir } from "../rin-lib/runtime.js";
import { safeString } from "../text-utils.js";

const HOME_DIR = os.homedir();

function sanitizeManagedSessionBasename(value: unknown, fallback: string) {
  const normalized = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_")
    .replace(/^[_./:-]+|[_./:-]+$/g, "");
  return normalized || fallback;
}

export function getManagedSessionRoot(agentDir: string) {
  return path.join(getRuntimeSessionDir(HOME_DIR, agentDir), "managed");
}

export function getManagedSubagentSessionDir(agentDir: string) {
  return path.join(getManagedSessionRoot(agentDir), "subagent");
}

export function getManagedTaskSessionDir(agentDir: string) {
  return path.join(getManagedSessionRoot(agentDir), "task");
}

export function getManagedSessionSearchDirs(agentDir: string) {
  return [
    getRuntimeSessionDir(HOME_DIR, agentDir),
    getManagedSubagentSessionDir(agentDir),
    getManagedTaskSessionDir(agentDir),
  ];
}

export function getManagedTaskSessionFile(agentDir: string, taskId: unknown) {
  return path.join(
    getManagedTaskSessionDir(agentDir),
    `${sanitizeManagedSessionBasename(taskId, "task")}.jsonl`,
  );
}
