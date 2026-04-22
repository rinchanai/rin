import type { CronTaskRecord } from "../rin-daemon/cron.js";
import { summarizeText } from "../rin-daemon/cron-utils.js";
import {
  findManagedSystemdJournalSnapshot,
  findManagedSystemdStatusSnapshot,
} from "../rin-install/managed-service.js";
import { createTargetExecutionContext, ParsedArgs, safeString } from "./shared.js";

function yesNo(value: unknown) {
  return value ? "yes" : "no";
}

function quoteValue(value: unknown) {
  return JSON.stringify(safeString(value).trim());
}

function renderTaskTrigger(task: Partial<CronTaskRecord>) {
  const trigger = task.trigger;
  if (trigger?.kind === "interval") {
    return `interval ${String(trigger.intervalMs || 0)}ms`;
  }
  if (trigger?.kind === "cron") {
    return `cron ${String(trigger.expression || "")}`.trim();
  }
  if (trigger?.kind === "once") {
    return `once ${String(trigger.runAt || "")}`.trim();
  }
  return "unknown";
}

function renderTaskTarget(task: Partial<CronTaskRecord>) {
  const target = task.target;
  if (target?.kind === "agent_prompt") {
    const summary = summarizeText(safeString(target.prompt), 60);
    return summary ? `agent_prompt:${summary}` : "agent_prompt";
  }
  if (target?.kind === "shell_command") {
    const summary = summarizeText(safeString(target.command), 60);
    return summary ? `shell_command:${summary}` : "shell_command";
  }
  return "unknown";
}

function renderTaskSession(task: Partial<CronTaskRecord>) {
  const mode = safeString(task.session?.mode).trim() || "unknown";
  const sessionFile =
    safeString(task.session?.sessionFile).trim() ||
    safeString(task.dedicatedSessionFile).trim();
  return sessionFile ? `${mode}:${sessionFile}` : mode;
}

function renderTaskState(task: Partial<CronTaskRecord>) {
  if (task.running) return "running";
  if (task.completedAt) {
    return `completed:${safeString(task.completedAt).trim() || "unknown"}`;
  }
  if (task.enabled === false) {
    const pausedAt = safeString(task.pausedAt).trim();
    return pausedAt ? `paused:${pausedAt}` : "disabled";
  }
  const nextRunAt = safeString(task.nextRunAt).trim();
  if (nextRunAt) return `next:${nextRunAt}`;
  return "pending";
}

function renderCronTaskLine(task: Partial<CronTaskRecord>) {
  const parts = [
    `daemonCron=${safeString(task.id).trim() || "unknown"}`,
    `name=${quoteValue(task.name)}`,
    `trigger=${quoteValue(renderTaskTrigger(task))}`,
    `target=${quoteValue(renderTaskTarget(task))}`,
    `session=${quoteValue(renderTaskSession(task))}`,
    `state=${quoteValue(renderTaskState(task))}`,
    `runs=${String(Number(task.runCount || 0))}`,
  ];
  const chatKey = safeString(task.chatKey).trim();
  if (chatKey) parts.push(`chat=${quoteValue(chatKey)}`);
  const lastStartedAt = safeString(task.lastStartedAt).trim();
  if (lastStartedAt) parts.push(`lastStartedAt=${lastStartedAt}`);
  const lastFinishedAt = safeString(task.lastFinishedAt).trim();
  if (lastFinishedAt) parts.push(`lastFinishedAt=${lastFinishedAt}`);
  const lastError = summarizeText(safeString(task.lastError), 120);
  if (lastError) parts.push(`lastError=${quoteValue(lastError)}`);
  return parts.join(" ");
}

export function renderDoctorDaemonStatusLines(daemonStatus: any) {
  const webSearchStatus = daemonStatus?.webSearch;
  const chatStatus = daemonStatus?.chat;
  const lines = [
    `webSearchRuntimeReady=${yesNo(webSearchStatus?.runtime?.ready)}`,
    `webSearchInstanceCount=${String(Array.isArray(webSearchStatus?.instances) ? webSearchStatus.instances.length : 0)}`,
  ];

  for (const instance of Array.isArray(webSearchStatus?.instances)
    ? webSearchStatus.instances
    : []) {
    lines.push(
      `webSearchInstance=${instance.instanceId} pid=${String(instance.pid || 0)} alive=${yesNo(instance.alive)} port=${String(instance.port || "")} baseUrl=${instance.baseUrl || ""}`,
    );
  }

  lines.push(
    `chatBridgeReady=${yesNo(chatStatus?.ready)}`,
    `chatBridgeAdapterCount=${String(chatStatus?.adapterCount ?? 0)}`,
    `chatBridgeBotCount=${String(chatStatus?.botCount ?? 0)}`,
    `chatBridgeControllerCount=${String(chatStatus?.controllerCount ?? 0)}`,
    `chatBridgeDetachedControllerCount=${String(chatStatus?.detachedControllerCount ?? 0)}`,
  );

  if (!daemonStatus) return lines;

  lines.push(`daemonWorkerCount=${String(daemonStatus.workerCount ?? 0)}`);
  const workerLines = Array.isArray(daemonStatus.workers)
    ? daemonStatus.workers.map((worker: any) => {
        const sessionFile = worker.sessionFile
          ? String(worker.sessionFile)
          : "-";
        return `daemonWorker=${String(worker.id)} pid=${String(worker.pid)} role=${String(worker.role)} attached=${String(worker.attachedConnections)} pending=${String(worker.pendingResponses)} streaming=${String(worker.isStreaming)} compacting=${String(worker.isCompacting)} session=${sessionFile}`;
      })
    : [];
  lines.push(...workerLines);

  const tasks = Array.isArray(daemonStatus.tasks) ? daemonStatus.tasks : [];
  const taskCount = Number(daemonStatus.taskCount ?? tasks.length) || 0;
  const runningTaskCount = tasks.filter((task: any) => task?.running).length;
  lines.push(
    `daemonCronTaskCount=${String(taskCount)}`,
    `daemonCronRunningCount=${String(runningTaskCount)}`,
  );
  lines.push(...tasks.map((task: any) => renderCronTaskLine(task)));

  return lines;
}

export async function runDoctor(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const socketReady = await context.canConnectSocket();
  const daemonStatus = socketReady
    ? await context.queryDaemonStatus()
    : undefined;
  const lines = [
    `targetUser=${context.targetUser}`,
    `installDir=${context.installDir}`,
    `socketPath=${context.socketPath}`,
    `socketReady=${socketReady ? "yes" : "no"}`,
    `serviceManager=${context.systemctl ? "systemd-user" : "none"}`,
    ...renderDoctorDaemonStatusLines(daemonStatus),
  ];

  if (context.systemctl) {
    const status = findManagedSystemdStatusSnapshot(
      context.managedServiceUnits,
      (unit) =>
        context.capture([
          context.systemctl,
          "--user",
          "status",
          unit,
          "--no-pager",
          "-l",
        ]),
    );
    if (status) {
      lines.push(
        `serviceUnit=${status.unit}`,
        "serviceStatus:",
        ...status.lines,
      );
    }

    const journal = findManagedSystemdJournalSnapshot(
      context.managedServiceUnits,
      (unit) =>
        context.capture([
          "journalctl",
          "--user",
          "-u",
          unit,
          "-n",
          "20",
          "--no-pager",
        ]),
    );
    if (journal) {
      lines.push(`serviceJournal=${journal.unit}`, ...journal.lines);
    }
  }

  console.log(lines.join("\n"));
}
