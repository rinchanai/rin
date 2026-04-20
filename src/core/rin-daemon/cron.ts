import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME_DIR = os.homedir();
import { cloneJson } from "../json-utils.js";
import { readJsonFile, writeJsonAtomic } from "../platform/fs.js";
import { safeString } from "../platform/process.js";
import { shellQuote } from "../rin-lib/system.js";
import { executeCronTask } from "./cron-execution.js";
import {
  computeNextRunAt,
  createCronTaskId,
  cronTasksPath,
  nextCronAt,
  normalizeIso,
  nowIso,
} from "./cron-utils.js";

export type CronTaskTarget =
  | {
      kind: "agent_prompt";
      prompt: string;
    }
  | {
      kind: "shell_command";
      command: string;
    };

export type CronTaskTrigger =
  | {
      kind: "interval";
      intervalMs: number;
      startAt?: string;
    }
  | {
      kind: "cron";
      expression: string;
      timezone?: "local";
    }
  | {
      kind: "once";
      runAt: string;
    };

export type CronTaskTermination = {
  maxRuns?: number;
  stopAt?: string;
};

export type CronTaskSessionBinding = {
  mode: "current" | "dedicated";
  sessionFile?: string;
};

export type CronTaskRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  builtIn?: boolean;
  createdFrom?: {
    sessionFile?: string;
    sessionId?: string;
    sessionName?: string;
    chatKey?: string;
  };
  name?: string;
  enabled: boolean;
  completedAt?: string;
  completionReason?: string;
  pausedAt?: string;
  chatKey?: string;
  trigger: CronTaskTrigger;
  termination?: CronTaskTermination;
  session: CronTaskSessionBinding;
  target: CronTaskTarget;
  dedicatedSessionFile?: string;
  dedicatedSessionPersistent?: boolean;
  nextRunAt?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResultText?: string;
  lastError?: string;
  runCount: number;
  running: boolean;
};

export type CronTaskInput = {
  id?: string;
  name?: string;
  enabled?: boolean;
  chatKey?: string | null;
  trigger?: CronTaskTrigger;
  termination?: CronTaskTermination | null;
  session?: CronTaskSessionBinding;
  target?: CronTaskTarget;
};

function createBuiltInMemoryIndexRepairTask(agentDir: string): CronTaskRecord {
  const createdAt = nowIso();
  const command = `${shellQuote(process.execPath)} ${shellQuote(path.join(agentDir, "app", "current", "dist", "app", "rin", "main.js"))} memory-index repair`;
  const task: CronTaskRecord = {
    id: "builtin_memory_index_repair_daily",
    builtIn: true,
    createdAt,
    updatedAt: createdAt,
    name: "Repair memory search index",
    enabled: true,
    trigger: {
      kind: "cron",
      expression: "17 4 * * *",
      timezone: "local",
    },
    session: { mode: "dedicated" },
    target: { kind: "shell_command", command },
    runCount: 0,
    running: false,
  };
  task.nextRunAt = computeNextRunAt(task, Date.now());
  return task;
}

function mergeBuiltInTaskState(
  existing: CronTaskRecord | undefined,
  builtin: CronTaskRecord,
): CronTaskRecord {
  if (!existing) return builtin;
  const merged: CronTaskRecord = {
    ...builtin,
    createdAt: safeString(existing.createdAt).trim() || builtin.createdAt,
    updatedAt: safeString(existing.updatedAt).trim() || builtin.updatedAt,
    lastStartedAt: existing.lastStartedAt,
    lastFinishedAt: existing.lastFinishedAt,
    lastResultText: existing.lastResultText,
    lastError: existing.lastError ? safeString(existing.lastError) : undefined,
    runCount: Number(existing.runCount || 0),
    nextRunAt:
      safeString(existing.nextRunAt).trim() ||
      computeNextRunAt(builtin, Date.now()),
    running: false,
  };
  return merged;
}

function assertMutableTask(task: CronTaskRecord | undefined) {
  if (!task) return;
  if (task.builtIn) throw new Error(`cron_builtin_task_protected:${task.id}`);
}

export class CronScheduler {
  private tasks = new Map<string, CronTaskRecord>();
  private activeExecutions = new Map<string, { startedAt: number }>();
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;

  constructor(
    private options: {
      agentDir: string;
      additionalExtensionPaths?: string[];
      chat?: {
        send?: (payload: any) => Promise<any>;
        runTurn?: (payload: any) => Promise<any>;
      };
    },
  ) {}

  start() {
    this.load();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
    void this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.save();
  }

  listTasks(options: { includeBuiltIn?: boolean } = {}) {
    return Array.from(this.tasks.values())
      .filter((task) => options.includeBuiltIn || !task.builtIn)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((task) => this.publicTask(task));
  }

  getTask(taskId: string, options: { includeBuiltIn?: boolean } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (!options.includeBuiltIn && task.builtIn) return undefined;
    return this.publicTask(task);
  }

  upsertTask(
    input: CronTaskInput,
    defaults: {
      sessionFile?: string;
      sessionId?: string;
      sessionName?: string;
      chatKey?: string;
    } = {},
  ) {
    const existing = input.id ? this.tasks.get(String(input.id)) : undefined;
    assertMutableTask(existing);
    const id = existing?.id || safeString(input.id).trim() || createCronTaskId();
    const createdAt = existing?.createdAt || nowIso();
    const updatedAt = nowIso();
    const name =
      input.name !== undefined
        ? safeString(input.name).trim() || undefined
        : existing?.name;
    const chatKey =
      input.chatKey === null
        ? undefined
        : input.chatKey !== undefined
          ? safeString(input.chatKey).trim() || undefined
          : existing?.chatKey;

    const trigger = input.trigger ?? existing?.trigger;
    if (!trigger) throw new Error("cron_trigger_required");
    const normalizedTrigger: CronTaskTrigger =
      trigger.kind === "interval"
        ? {
            kind: "interval",
            intervalMs: Math.max(1_000, Number(trigger.intervalMs || 0)),
            startAt: normalizeIso(trigger.startAt, "startAt"),
          }
        : trigger.kind === "cron"
          ? {
              kind: "cron",
              expression: safeString(trigger.expression).trim(),
              timezone: "local",
            }
          : {
              kind: "once",
              runAt:
                normalizeIso(trigger.runAt, "runAt") ||
                (() => {
                  throw new Error("cron_runAt_required");
                })(),
            };

    const session = input.session ?? existing?.session;
    if (!session) throw new Error("cron_session_required");
    if (session.mode !== "current" && session.mode !== "dedicated") {
      throw new Error(`cron_invalid_session_mode:${safeString((session as any).mode).trim() || "unknown"}`);
    }
    const explicitSessionFile = safeString(session.sessionFile).trim();
    const normalizedSession: CronTaskSessionBinding = {
      mode: session.mode,
      sessionFile:
        session.mode === "current"
          ? path.resolve(
              HOME_DIR,
              safeString(
                session.sessionFile || defaults.sessionFile,
              ).trim() ||
                (() => {
                  throw new Error("cron_current_session_required");
                })(),
            )
          : undefined,
    };
    const dedicatedSessionPersistent =
      session.mode === "dedicated" ? true : undefined;
    const dedicatedSessionFile =
      session.mode === "dedicated"
        ? explicitSessionFile
          ? path.resolve(HOME_DIR, explicitSessionFile)
          : existing?.dedicatedSessionFile
        : undefined;

    const target = input.target ?? existing?.target;
    if (!target) throw new Error("cron_target_required");
    const normalizedTarget: CronTaskTarget =
      target.kind === "agent_prompt"
        ? {
            kind: "agent_prompt",
            prompt:
              safeString(target.prompt).trim() ||
              (() => {
                throw new Error("cron_prompt_required");
              })(),
          }
        : {
            kind: "shell_command",
            command:
              safeString(target.command).trim() ||
              (() => {
                throw new Error("cron_command_required");
              })(),
          };

    const termination =
      input.termination === null
        ? undefined
        : input.termination !== undefined
          ? {
              maxRuns: input.termination?.maxRuns
                ? Math.max(1, Number(input.termination.maxRuns))
                : undefined,
              stopAt: normalizeIso(input.termination?.stopAt, "stopAt"),
            }
          : existing?.termination;

    const enabled =
      input.enabled !== undefined
        ? Boolean(input.enabled)
        : (existing?.enabled ?? true);
    const nextRunAt = computeNextRunAt(
      {
        id,
        createdAt,
        updatedAt,
        createdFrom: existing?.createdFrom || {
          sessionFile: defaults.sessionFile,
          sessionId: defaults.sessionId,
          sessionName: defaults.sessionName,
          chatKey: defaults.chatKey,
        },
        name,
        enabled,
        completedAt: existing?.completedAt,
        completionReason: existing?.completionReason,
        pausedAt: existing?.pausedAt,
        chatKey,
        trigger: normalizedTrigger,
        termination,
        session: normalizedSession,
        target: normalizedTarget,
        dedicatedSessionFile,
        dedicatedSessionPersistent,
        nextRunAt: existing?.nextRunAt,
        lastStartedAt: existing?.lastStartedAt,
        lastFinishedAt: existing?.lastFinishedAt,
        lastResultText: existing?.lastResultText,
        lastError: existing?.lastError,
        runCount: existing?.runCount ?? 0,
        running: false,
      },
      Date.now(),
    );

    const task: CronTaskRecord = {
      id,
      createdAt,
      updatedAt,
      createdFrom: existing?.createdFrom || {
        sessionFile: defaults.sessionFile,
        sessionId: defaults.sessionId,
        sessionName: defaults.sessionName,
        chatKey: defaults.chatKey,
      },
      name,
      enabled,
      completedAt: existing?.completedAt,
      completionReason: existing?.completionReason,
      pausedAt: existing?.pausedAt,
      chatKey,
      trigger: normalizedTrigger,
      termination,
      session: normalizedSession,
      target: normalizedTarget,
      dedicatedSessionFile,
      dedicatedSessionPersistent,
      nextRunAt,
      lastStartedAt: existing?.lastStartedAt,
      lastFinishedAt: existing?.lastFinishedAt,
      lastResultText: existing?.lastResultText,
      lastError: existing?.lastError,
      runCount: existing?.runCount ?? 0,
      running: false,
    };

    if (task.completedAt) {
      task.enabled = false;
      task.nextRunAt = undefined;
    }

    this.tasks.set(task.id, task);
    this.save();
    return this.publicTask(task);
  }

  deleteTask(taskId: string) {
    assertMutableTask(this.tasks.get(taskId));
    const ok = this.tasks.delete(taskId);
    if (ok) this.save();
    return ok;
  }

  completeTask(taskId: string, reason = "completed_by_agent") {
    const task = this.tasks.get(taskId);
    assertMutableTask(task);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    task.completedAt = nowIso();
    task.completionReason = safeString(reason).trim() || "completed";
    task.enabled = false;
    task.nextRunAt = undefined;
    task.updatedAt = nowIso();
    this.save();
    return this.publicTask(task);
  }

  pauseTask(taskId: string) {
    const task = this.tasks.get(taskId);
    assertMutableTask(task);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    task.enabled = false;
    task.pausedAt = nowIso();
    task.nextRunAt = undefined;
    task.updatedAt = nowIso();
    this.save();
    return this.publicTask(task);
  }

  resumeTask(taskId: string) {
    const task = this.tasks.get(taskId);
    assertMutableTask(task);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    task.enabled = true;
    delete task.pausedAt;
    task.nextRunAt = computeNextRunAt(task, Date.now());
    task.updatedAt = nowIso();
    this.save();
    return this.publicTask(task);
  }

  private load() {
    const file = cronTasksPath(this.options.agentDir);
    const rows = readJsonFile<CronTaskRecord[]>(file, []);
    this.tasks.clear();
    for (const row of rows) {
      if (!row || typeof row !== "object" || !row.id) continue;
      row.running = false;
      row.lastError = row.lastError ? safeString(row.lastError) : undefined;
      if ((row.session as any)?.mode === "dedicated") {
        row.dedicatedSessionPersistent = true;
      } else {
        delete row.dedicatedSessionFile;
        delete row.dedicatedSessionPersistent;
      }
      row.nextRunAt = row.completedAt
        ? undefined
        : row.nextRunAt || computeNextRunAt(row, Date.now());
      this.tasks.set(String(row.id), row);
    }
    this.installBuiltInTasks();
    this.save();
  }

  private snapshotTask(task: CronTaskRecord): CronTaskRecord {
    return {
      ...task,
      running: this.activeExecutions.has(task.id),
    };
  }

  private persistedTask(task: CronTaskRecord): CronTaskRecord {
    return {
      ...task,
      running: false,
    };
  }

  private publicTask(task: CronTaskRecord): CronTaskRecord {
    return cloneJson(this.snapshotTask(task));
  }

  private save() {
    writeJsonAtomic(
      cronTasksPath(this.options.agentDir),
      Array.from(this.tasks.values()).map((task) => this.persistedTask(task)),
    );
  }

  private installBuiltInTasks() {
    const builtin = createBuiltInMemoryIndexRepairTask(this.options.agentDir);
    const existing = this.tasks.get(builtin.id);
    this.tasks.set(builtin.id, mergeBuiltInTaskState(existing, builtin));
  }

  private async tick() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const now = Date.now();
      const due = Array.from(this.tasks.values())
        .filter(
          (task) =>
            task.enabled &&
            !this.activeExecutions.has(task.id) &&
            !task.completedAt &&
            task.nextRunAt &&
            Date.parse(task.nextRunAt) <= now,
        )
        .sort(
          (a, b) =>
            Date.parse(String(a.nextRunAt || a.createdAt)) -
            Date.parse(String(b.nextRunAt || b.createdAt)),
        );
      for (const task of due) {
        this.activeExecutions.set(task.id, { startedAt: Date.now() });
        task.lastStartedAt = nowIso();
        task.runCount += 1;
        task.lastError = undefined;
        task.updatedAt = nowIso();
        if (task.trigger.kind === "interval") {
          task.nextRunAt = computeNextRunAt(task, Date.now());
        } else if (task.trigger.kind === "cron") {
          task.nextRunAt = nextCronAt(task.trigger.expression, Date.now());
        } else {
          task.nextRunAt = undefined;
        }
        this.save();
        void this.executeTask(task).catch(() => {});
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async executeTask(task: CronTaskRecord) {
    try {
      await executeCronTask(task, this.options);
      if (!task.completedAt && task.trigger.kind !== "interval") {
        task.nextRunAt = computeNextRunAt(task, Date.now());
      }
    } finally {
      this.activeExecutions.delete(task.id);
      this.save();
    }
  }
}
