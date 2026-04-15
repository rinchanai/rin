import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { ensurePrivateDir, readJsonFile } from "../platform/fs.js";
import {
  acquireProcessLock,
  listInstanceIds as listSidecarInstanceIds,
  readInstanceState as readSidecarInstanceState,
  writeInstanceState as writeSidecarInstanceState,
} from "../sidecar/common.js";
import type {
  SidecarInstanceState,
  SidecarStatusRow,
} from "../sidecar/types.js";
import { isPidAlive, safeString, sleep } from "../platform/process.js";

const START_TIMEOUT_MS = 15_000;

function chatRootForState(stateRoot: string) {
  const root = path.resolve(stateRoot);
  const preferred = path.join(root, "data", "chat-sidecar");
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(root, "data", "koishi-sidecar");
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

function instancesRootForState(stateRoot: string) {
  return path.join(chatRootForState(stateRoot), "instances");
}

function lockPathForState(stateRoot: string) {
  return path.join(chatRootForState(stateRoot), "start.lock");
}

function instanceRootForState(stateRoot: string, instanceId: string) {
  return path.join(instancesRootForState(stateRoot), instanceId);
}

function instanceStateFileForState(stateRoot: string, instanceId: string) {
  return path.join(instanceRootForState(stateRoot, instanceId), "state.json");
}

function readInstanceState(stateRoot: string, instanceId: string) {
  return readSidecarInstanceState<any>(
    instanceStateFileForState(stateRoot, instanceId),
  );
}

function listInstanceIds(stateRoot: string) {
  return listSidecarInstanceIds(instancesRootForState(stateRoot));
}

function writeInstanceState(stateRoot: string, instanceId: string, value: any) {
  writeSidecarInstanceState(
    instanceStateFileForState(stateRoot, instanceId),
    value,
  );
}

function resolveChatEntry(entryPath?: string) {
  const provided = safeString(entryPath).trim();
  if (provided) return provided;
  return path.join(path.dirname(new URL(import.meta.url).pathname), "main.js");
}

async function ensureProcessStarted(pid: number, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    if (isPidAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

async function ensureChatSidecar(
  stateRoot: string,
  options: { instanceId?: string; entryPath?: string } = {},
) {
  const instanceId =
    safeString(options.instanceId).trim() || `chat-${process.pid}`;
  const existing = readInstanceState(stateRoot, instanceId);
  if (existing?.pid && isPidAlive(Number(existing.pid || 0))) {
    return {
      ok: true,
      instanceId,
      pid: Number(existing.pid || 0),
      reused: true,
    };
  }

  const release = await acquireProcessLock(lockPathForState(stateRoot)).catch(
    (error: any) => {
      throw new Error(
        String(
          error?.message ||
            error ||
            `chat_lock_timeout:${lockPathForState(stateRoot)}`,
        ),
      );
    },
  );
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const chatEntry = resolveChatEntry(options.entryPath);
    child = spawn(process.execPath, [chatEntry], {
      cwd: path.resolve(stateRoot),
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    try {
      child.unref();
    } catch {}

    writeInstanceState(stateRoot, instanceId, {
      pid: Number(child.pid || 0),
      entryPath: chatEntry,
      startedAt: new Date().toISOString(),
      ownerPid: process.pid,
    });

    const started = await ensureProcessStarted(
      Number(child.pid || 0),
      START_TIMEOUT_MS,
    );
    if (!started) throw new Error("chat_start_timeout");
    return { ok: true, instanceId, pid: Number(child.pid || 0), reused: false };
  } finally {
    try {
      release();
    } catch {}
    if (child && !(Number(child.pid || 0) > 1 && isPidAlive(child.pid))) {
      try {
        fs.rmSync(instanceStateFileForState(stateRoot, instanceId), {
          force: true,
        });
      } catch {}
    }
  }
}

async function stopChatSidecar(
  stateRoot: string,
  options: { instanceId?: string } = {},
) {
  const instanceId = safeString(options.instanceId).trim();
  if (!instanceId) return { ok: false, error: "chat_instance_required" };
  const current = readInstanceState(stateRoot, instanceId) || {};
  if (Number(current.pid || 0) > 1 && isPidAlive(current.pid)) {
    try {
      process.kill(Number(current.pid), "SIGTERM");
    } catch {}
  }
  try {
    fs.rmSync(instanceRootForState(stateRoot, instanceId), {
      recursive: true,
      force: true,
    });
  } catch {}
  return { ok: true, pid: Number(current.pid || 0) };
}

async function cleanupOrphanChatSidecars(stateRoot: string) {
  const cleaned: Array<{ instanceId: string; pid: number; ownerPid?: number }> =
    [];
  for (const instanceId of listInstanceIds(stateRoot)) {
    const state = readInstanceState(stateRoot, instanceId) || {};
    const ownerPid = Number(state?.ownerPid || 0);
    const pid = Number(state?.pid || 0);
    if (!(ownerPid > 1)) continue;
    if (isPidAlive(ownerPid)) continue;
    if (pid > 1 && isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      await sleep(150);
    }
    try {
      fs.rmSync(instanceRootForState(stateRoot, instanceId), {
        recursive: true,
        force: true,
      });
    } catch {}
    cleaned.push({ instanceId, pid, ownerPid });
  }
  return { ok: true, cleaned };
}

function getChatSidecarStatus(stateRoot: string) {
  const instances = listInstanceIds(stateRoot).map(
    (instanceId): SidecarStatusRow => {
      const state = (readInstanceState(stateRoot, instanceId) ||
        {}) as SidecarInstanceState;
      const pid = Number(state?.pid || 0);
      return {
        instanceId,
        pid,
        alive: isPidAlive(pid),
        startedAt: safeString(state?.startedAt).trim(),
        ownerPid: Number(state?.ownerPid || 0) || undefined,
        entryPath: safeString(state?.entryPath).trim(),
        statePath: instanceStateFileForState(stateRoot, instanceId),
      };
    },
  );
  return {
    root: chatRootForState(stateRoot),
    instances,
  };
}

export {
  cleanupOrphanChatSidecars,
  ensureChatSidecar,
  getChatSidecarStatus,
  stopChatSidecar,
};
