import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  maintainMemory,
  maintainSessionSummary,
} from "./maintainer.js";
import { safeString } from "./core/utils.js";

export type MaintenanceJob = {
  id: string;
  kind: "self_improve_review" | "session_summary";
  createdAt: string;
  updatedAt: string;
  agentDir: string;
  sessionFile: string;
  leafId?: string;
  trigger: string;
  snapshotKey?: string;
  additionalExtensionPaths?: string[];
  attempts?: number;
  lastError?: string;
  lastAttemptAt?: string;
};

type MaintenanceChangedFile = {
  path: string;
  change: "created" | "updated" | "deleted";
};

type MaintenanceHistoryRecord = {
  id: string;
  kind: MaintenanceJob["kind"];
  status: "completed" | "failed" | "retry_scheduled";
  trigger: string;
  sessionFile: string;
  leafId?: string;
  snapshotKey?: string;
  startedAt: string;
  finishedAt: string;
  attempts: number;
  skipped?: string;
  error?: string;
  outputPreview?: string;
  changedFiles?: MaintenanceChangedFile[];
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

function historyPath(agentDir: string) {
  return path.join(stateDir(agentDir), "maintenance-history.jsonl");
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

async function appendJsonLine(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function loadQueue(agentDir: string): Promise<MaintenanceJob[]> {
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

async function saveQueue(agentDir: string, jobs: MaintenanceJob[]) {
  await ensureStateDir(agentDir);
  await writeJsonAtomic(queuePath(agentDir), jobs);
}

function sameJob(a: Partial<MaintenanceJob>, b: Partial<MaintenanceJob>) {
  const sameBase =
    safeString(a.kind).trim() === safeString(b.kind).trim() &&
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

function defaultTrigger(kind: MaintenanceJob["kind"]) {
  return kind === "session_summary"
    ? "session_summary:review"
    : "self_improve:review";
}

async function enqueueMaintenanceJob(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt">,
) {
  const agentDir = path.resolve(safeString(input.agentDir).trim());
  const sessionFile = path.resolve(safeString(input.sessionFile).trim());
  const kind =
    safeString(input.kind).trim() === "session_summary"
      ? "session_summary"
      : "self_improve_review";
  const trigger = safeString(input.trigger).trim() || defaultTrigger(kind);
  const snapshotKey = safeString(input.snapshotKey).trim();
  const leafId = safeString(input.leafId).trim();
  if (!agentDir || !sessionFile) {
    throw new Error("maintenance_job_invalid_input");
  }

  const jobs = await loadQueue(agentDir);
  const existing = jobs.find((job) =>
    sameJob(job, { kind, agentDir, sessionFile, snapshotKey }),
  );
  const updatedAt = nowIso();
  if (existing) {
    existing.updatedAt = updatedAt;
    existing.kind = kind;
    existing.trigger = trigger;
    existing.leafId = leafId || undefined;
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
      id: `maintenance_job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      kind,
      createdAt: updatedAt,
      updatedAt,
      agentDir,
      sessionFile,
      leafId: leafId || undefined,
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

export async function enqueueMemoryMaintenanceJob(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt" | "kind">,
) {
  await enqueueMaintenanceJob({
    ...input,
    kind: "self_improve_review",
  });
}

export async function enqueueSessionSummaryJob(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt" | "kind">,
) {
  await enqueueMaintenanceJob({
    ...input,
    kind: "session_summary",
  });
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

async function replaceMatchingJob(
  agentDir: string,
  target: MaintenanceJob,
  replacement?: MaintenanceJob,
) {
  const jobs = await loadQueue(agentDir);
  const remaining = jobs.filter((job) => !sameJob(job, target));
  if (replacement) remaining.push(replacement);
  await saveQueue(agentDir, remaining);
}

async function removeMatchingJobs(agentDir: string, target: MaintenanceJob) {
  await replaceMatchingJob(agentDir, target);
}

function normalizeChangedFiles(value: unknown): MaintenanceChangedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      path: safeString((item as any)?.path).trim(),
      change: safeString((item as any)?.change).trim(),
    }))
    .filter((item) => item.path)
    .map((item) => ({
      path: item.path,
      change:
        item.change === "created" ||
        item.change === "updated" ||
        item.change === "deleted"
          ? item.change
          : "updated",
    }));
}

function truncateText(value: unknown, limit = 800) {
  const text = safeString(value).trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function normalizeErrorMessage(error: unknown) {
  return safeString((error as any)?.message || error || "maintenance_job_failed").trim();
}

function isPermanentJobError(message: string) {
  return [
    "maintenance_job_invalid_input",
    "maintenance_job_invalid_payload",
    "maintenance_job_missing_session_file:",
    "maintenance_job_invalid_session_file:",
    "session_file_required",
    "Cannot fork: source session file is empty or invalid:",
  ].some((needle) => message.includes(needle));
}

async function appendHistoryRecord(
  agentDir: string,
  record: MaintenanceHistoryRecord,
) {
  await appendJsonLine(historyPath(agentDir), record);
}

async function assertUsableSessionFile(sessionFile: string) {
  try {
    const stat = await fs.stat(sessionFile);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`maintenance_job_invalid_session_file:${sessionFile}`);
    }
  } catch (error: any) {
    if (error?.message?.startsWith("maintenance_job_invalid_session_file:")) {
      throw error;
    }
    throw new Error(`maintenance_job_missing_session_file:${sessionFile}`);
  }
}

async function processJob(job: MaintenanceJob) {
  const agentDir = path.resolve(safeString(job.agentDir).trim());
  const sessionFile = path.resolve(safeString(job.sessionFile).trim());
  const leafId = safeString(job.leafId).trim() || undefined;
  if (!agentDir || !sessionFile) {
    throw new Error("maintenance_job_invalid_payload");
  }
  await assertUsableSessionFile(sessionFile);
  if (job.kind === "session_summary") {
    return await maintainSessionSummary(
      {} as any,
      {
        agentDir,
        sessionFile,
        leafId,
        trigger: job.trigger,
      },
    );
  }
  return await maintainMemory(
    {} as any,
    {
      agentDir,
      sessionFile,
      leafId,
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
  let failed = 0;
  let retried = 0;
  const deferredRetryIds = new Set<string>();
  try {
    while (true) {
      const jobs = await loadQueue(resolvedAgentDir);
      const job = jobs[0];
      if (!job) break;
      if (deferredRetryIds.has(job.id)) break;
      const startedAt = nowIso();
      try {
        const result = await processJob(job);
        const finishedAt = nowIso();
        await removeMatchingJobs(resolvedAgentDir, job);
        await appendHistoryRecord(resolvedAgentDir, {
          id: job.id,
          kind: job.kind,
          status: "completed",
          trigger: job.trigger,
          sessionFile: job.sessionFile,
          leafId: job.leafId,
          snapshotKey: job.snapshotKey,
          startedAt,
          finishedAt,
          attempts: Math.max(1, Number(job.attempts || 0) || 1),
          skipped: safeString((result as any)?.skipped).trim() || undefined,
          outputPreview:
            truncateText((result as any)?.output || (result as any)?.sessionSummary) ||
            undefined,
          changedFiles: normalizeChangedFiles((result as any)?.changedFiles),
        });
        processed += 1;
      } catch (error: unknown) {
        const finishedAt = nowIso();
        const message = normalizeErrorMessage(error);
        const attempts = Math.max(1, Number(job.attempts || 0) + 1);
        const updatedJob: MaintenanceJob = {
          ...job,
          attempts,
          updatedAt: finishedAt,
          lastAttemptAt: finishedAt,
          lastError: message,
        };
        const permanent = isPermanentJobError(message);
        if (permanent || attempts >= 3) {
          await removeMatchingJobs(resolvedAgentDir, job);
          await appendHistoryRecord(resolvedAgentDir, {
            id: job.id,
            kind: job.kind,
            status: "failed",
            trigger: job.trigger,
            sessionFile: job.sessionFile,
            leafId: job.leafId,
            snapshotKey: job.snapshotKey,
            startedAt,
            finishedAt,
            attempts,
            error: message,
          });
          failed += 1;
          continue;
        }
        await replaceMatchingJob(resolvedAgentDir, job, updatedJob);
        await appendHistoryRecord(resolvedAgentDir, {
          id: job.id,
          kind: job.kind,
          status: "retry_scheduled",
          trigger: job.trigger,
          sessionFile: job.sessionFile,
          leafId: job.leafId,
          snapshotKey: job.snapshotKey,
          startedAt,
          finishedAt,
          attempts,
          error: message,
        });
        retried += 1;
        deferredRetryIds.add(job.id);
      }
    }
    return { skipped: "", processed, failed, retried };
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
