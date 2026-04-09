import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../platform/fs.js";
import { safeString } from "../platform/process.js";
import { executeCronTask } from "./cron-execution.js";
import {
  computeNextRunAt,
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
      shell?: string;
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
  mode: "current" | "dedicated" | "specific";
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
  cwd: string;
  trigger: CronTaskTrigger;
  termination?: CronTaskTermination;
  session: CronTaskSessionBinding;
  target: CronTaskTarget;
  dedicatedSessionFile?: string;
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
  cwd?: string;
  trigger?: CronTaskTrigger;
  termination?: CronTaskTermination | null;
  session?: CronTaskSessionBinding;
  target?: CronTaskTarget;
};

export class CronScheduler {
  private tasks = new Map<string, CronTaskRecord>();
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;

  constructor(
    private options: {
      agentDir: string;
      cwd: string;
      additionalExtensionPaths?: string[];
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

  listTasks() {
    return Array.from(this.tasks.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((task) => JSON.parse(JSON.stringify(task)));
  }

  getTask(taskId: string) {
    const task = this.tasks.get(taskId);
    return task ? JSON.parse(JSON.stringify(task)) : undefined;
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
    const id =
      existing?.id ||
      safeString(input.id).trim() ||
      `cron_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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

    const cwd = input.cwd
      ? path.resolve(String(input.cwd))
      : existing?.cwd || this.options.cwd;

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
    const normalizedSession: CronTaskSessionBinding = {
      mode: session.mode,
      sessionFile:
        session.mode === "specific"
          ? path.resolve(
              safeString(session.sessionFile).trim() ||
                (() => {
                  throw new Error("cron_sessionFile_required");
                })(),
            )
          : session.mode === "current"
            ? path.resolve(
                safeString(
                  session.sessionFile || defaults.sessionFile,
                ).trim() ||
                  (() => {
                    throw new Error("cron_current_session_required");
                  })(),
              )
            : undefined,
    };

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
            shell: safeString(target.shell).trim() || undefined,
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
        cwd,
        trigger: normalizedTrigger,
        termination,
        session: normalizedSession,
        target: normalizedTarget,
        dedicatedSessionFile: existing?.dedicatedSessionFile,
        nextRunAt: existing?.nextRunAt,
        lastStartedAt: existing?.lastStartedAt,
        lastFinishedAt: existing?.lastFinishedAt,
        lastResultText: existing?.lastResultText,
        lastError: existing?.lastError,
        runCount: existing?.runCount ?? 0,
        running: existing?.running ?? false,
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
      cwd,
      trigger: normalizedTrigger,
      termination,
      session: normalizedSession,
      target: normalizedTarget,
      dedicatedSessionFile: existing?.dedicatedSessionFile,
      nextRunAt,
      lastStartedAt: existing?.lastStartedAt,
      lastFinishedAt: existing?.lastFinishedAt,
      lastResultText: existing?.lastResultText,
      lastError: existing?.lastError,
      runCount: existing?.runCount ?? 0,
      running: existing?.running ?? false,
    };

    if (task.completedAt) {
      task.enabled = false;
      task.nextRunAt = undefined;
    }

    this.tasks.set(task.id, task);
    this.save();
    return JSON.parse(JSON.stringify(task));
  }

  deleteTask(taskId: string) {
    const ok = this.tasks.delete(taskId);
    if (ok) this.save();
    return ok;
  }

  completeTask(taskId: string, reason = "completed_by_agent") {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    task.completedAt = nowIso();
    task.completionReason = safeString(reason).trim() || "completed";
    task.enabled = false;
    task.running = false;
    task.nextRunAt = undefined;
    task.updatedAt = nowIso();
    this.save();
    return JSON.parse(JSON.stringify(task));
  }

  pauseTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    task.enabled = false;
    task.pausedAt = nowIso();
    task.nextRunAt = undefined;
    task.updatedAt = nowIso();
    this.save();
    return JSON.parse(JSON.stringify(task));
  }

  resumeTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    task.enabled = true;
    delete task.pausedAt;
    task.nextRunAt = computeNextRunAt(task, Date.now());
    task.updatedAt = nowIso();
    this.save();
    return JSON.parse(JSON.stringify(task));
  }

  private load() {
    const file = cronTasksPath(this.options.agentDir);
    const rows = readJsonFile<CronTaskRecord[]>(file, []);
    this.tasks.clear();
    for (const row of rows) {
      if (!row || typeof row !== "object" || !row.id) continue;
      row.running = false;
      row.lastError = row.lastError ? safeString(row.lastError) : undefined;
      row.nextRunAt = row.completedAt
        ? undefined
        : row.nextRunAt || computeNextRunAt(row, Date.now());
      this.tasks.set(String(row.id), row);
    }
    this.save();
  }

  private save() {
    writeJsonAtomic(
      cronTasksPath(this.options.agentDir),
      Array.from(this.tasks.values()).filter((task) => !task.builtIn),
    );
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
            !task.running &&
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
        task.running = true;
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
    await executeCronTask(task, this.options);
    if (!task.completedAt && task.trigger.kind !== "interval") {
      task.nextRunAt = computeNextRunAt(task, Date.now());
    }
    this.save();
  }
}
