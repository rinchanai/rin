import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { maintainMemory } from "./maintainer.js";
import { safeString } from "./core/utils.js";

export type MemoryMaintenanceJob = {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentDir: string;
  sessionFile: string;
  trigger: string;
  snapshotKey?: string;
  additionalExtensionPaths?: string[];
};

function nowIso() {
  return new Date().toISOString();
}

function stateDir(agentDir: string) {
  return path.join(path.resolve(agentDir), "self_improve", "state");
}

function queuePath(agentDir: string) {
  return path.join(stateDir(agentDir), "maintenance-queue.json");
}

function lockPath(agentDir: string) {
  return path.join(stateDir(agentDir), "maintenance-worker.lock");
}

async function ensureStateDir(agentDir: string) {
  await fs.mkdir(stateDir(agentDir), { recursive: true });
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function loadQueue(agentDir: string): Promise<MemoryMaintenanceJob[]> {
  try {
    const raw = await fs.readFile(queuePath(agentDir), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item === "object")
      : [];
  } catch {
    return [];
  }
}

async function saveQueue(agentDir: string, jobs: MemoryMaintenanceJob[]) {
  await ensureStateDir(agentDir);
  await writeJsonAtomic(queuePath(agentDir), jobs);
}

function sameJob(
  a: Partial<MemoryMaintenanceJob>,
  b: Partial<MemoryMaintenanceJob>,
) {
  const sameBase =
    safeString(a.agentDir).trim() === safeString(b.agentDir).trim() &&
    safeString(a.sessionFile).trim() === safeString(b.sessionFile).trim();
  if (!sameBase) return false;
  const aSnapshotKey = safeString(a.snapshotKey).trim();
  const bSnapshotKey = safeString(b.snapshotKey).trim();
  if (aSnapshotKey || bSnapshotKey) {
    return aSnapshotKey === bSnapshotKey;
  }
  return true;
}

export async function enqueueMemoryMaintenanceJob(
  input: Omit<MemoryMaintenanceJob, "id" | "createdAt" | "updatedAt">,
) {
  const agentDir = path.resolve(safeString(input.agentDir).trim());
  const sessionFile = path.resolve(safeString(input.sessionFile).trim());
  const trigger =
    safeString(input.trigger).trim() || "extension:memory_maintainer";
  const snapshotKey = safeString(input.snapshotKey).trim();
  if (!agentDir || !sessionFile)
    throw new Error("memory_job_invalid_input");

  const jobs = await loadQueue(agentDir);
  const existing = jobs.find((job) =>
    sameJob(job, { agentDir, sessionFile, snapshotKey }),
  );
  const updatedAt = nowIso();
  if (existing) {
    existing.updatedAt = updatedAt;
    existing.trigger = trigger;
    existing.snapshotKey = snapshotKey || undefined;
    existing.additionalExtensionPaths = Array.isArray(
      input.additionalExtensionPaths,
    )
      ? input.additionalExtensionPaths
          .map((item) => safeString(item).trim())
          .filter(Boolean)
      : undefined;
  } else {
    jobs.push({
      id: `memory_job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      createdAt: updatedAt,
      updatedAt,
      agentDir,
      sessionFile,
      trigger,
      snapshotKey: snapshotKey || undefined,
      additionalExtensionPaths: Array.isArray(input.additionalExtensionPaths)
        ? input.additionalExtensionPaths
            .map((item) => safeString(item).trim())
            .filter(Boolean)
        : undefined,
    });
  }
  await saveQueue(agentDir, jobs);
}

function processExists(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireWorkerLock(agentDir: string) {
  await ensureStateDir(agentDir);
  const filePath = lockPath(agentDir);
  try {
    const handle = await fs.open(filePath, "wx");
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: nowIso() })}\n`,
      "utf8",
    );
    return handle;
  } catch (error: any) {
    if (error?.code !== "EEXIST") return null;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const pid = Number(parsed?.pid || 0);
      if (!processExists(pid)) {
        await fs.rm(filePath, { force: true });
        const handle = await fs.open(filePath, "wx");
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, createdAt: nowIso() })}\n`,
          "utf8",
        );
        return handle;
      }
    } catch {}
    return null;
  }
}

async function releaseWorkerLock(
  agentDir: string,
  handle: fs.FileHandle | null,
) {
  try {
    await handle?.close();
  } catch {}
  try {
    await fs.rm(lockPath(agentDir), { force: true });
  } catch {}
}

async function removeMatchingJobs(
  agentDir: string,
  target: MemoryMaintenanceJob,
) {
  const jobs = await loadQueue(agentDir);
  const remaining = jobs.filter((job) => !sameJob(job, target));
  await saveQueue(agentDir, remaining);
}

async function processJob(job: MemoryMaintenanceJob) {
  const agentDir = path.resolve(safeString(job.agentDir).trim());
  const sessionFile = path.resolve(safeString(job.sessionFile).trim());
  if (!agentDir || !sessionFile) {
    throw new Error("memory_job_invalid_payload");
  }
  await maintainMemory(
    {} as any,
    {
      sessionFile,
      trigger: job.trigger,
      additionalExtensionPaths: job.additionalExtensionPaths,
    },
  );
}

export async function processQueuedMemoryJobs(agentDir: string) {
  const resolvedAgentDir = path.resolve(safeString(agentDir).trim());
  if (!resolvedAgentDir) return { skipped: "no-agent-dir" };
  const handle = await acquireWorkerLock(resolvedAgentDir);
  if (!handle) return { skipped: "locked" };
  let processed = 0;
  try {
    while (true) {
      const jobs = await loadQueue(resolvedAgentDir);
      const job = jobs[0];
      if (!job) break;
      await processJob(job);
      await removeMatchingJobs(resolvedAgentDir, job);
      processed += 1;
    }
    return { skipped: "", processed };
  } finally {
    await releaseWorkerLock(resolvedAgentDir, handle);
  }
}

export function spawnQueuedMemoryWorker(agentDir: string) {
  const resolvedAgentDir = path.resolve(safeString(agentDir).trim());
  if (!resolvedAgentDir) return false;
  const workerPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "worker.js",
  );
  if (!fssync.existsSync(workerPath)) return false;
  const child = spawn(
    process.execPath,
    [workerPath, "--agent-dir", resolvedAgentDir],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return true;
}
