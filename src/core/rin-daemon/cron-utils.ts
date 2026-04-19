import path from "node:path";

import { safeString } from "../platform/process.js";

import type { CronTaskRecord } from "./cron.js";

export function normalizeIso(value: unknown, field: string) {
  const text = safeString(value).trim();
  if (!text) return undefined;
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) throw new Error(`cron_invalid_${field}`);
  return new Date(ts).toISOString();
}

export function nowIso() {
  return new Date().toISOString();
}

export function cronRoot(agentDir: string) {
  return path.join(path.resolve(agentDir), "data", "cron");
}

export function cronTasksPath(agentDir: string) {
  return path.join(cronRoot(agentDir), "tasks.json");
}

export function createCronTaskId() {
  return `cron_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function cronTaskRunId(task: CronTaskRecord) {
  return `${task.id}:${task.runCount}:${Date.now()}`;
}

export function summarizeText(value: string, max = 1200) {
  const text = safeString(value).replace(/\r/g, "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function formatCronField(field: string, min: number, max: number) {
  const allowed = new Set<number>();
  const chunks = field
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!chunks.length) throw new Error("cron_invalid_expression");

  for (const chunk of chunks) {
    const [rangePart, stepPart] = chunk.split("/");
    const step = stepPart == null ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0)
      throw new Error("cron_invalid_expression");

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      const rangeMatch = rangePart.match(/^(\d+)(?:-(\d+))?$/);
      if (!rangeMatch) throw new Error("cron_invalid_expression");
      start = Number(rangeMatch[1]);
      end = rangeMatch[2] == null ? start : Number(rangeMatch[2]);
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error("cron_invalid_expression");
    }

    for (let value = start; value <= end; value += step) allowed.add(value);
  }

  return allowed;
}

export function nextCronAt(expression: string, afterTs: number) {
  const parts = safeString(expression).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron_invalid_expression");
  const [minuteField, hourField, dayField, monthField, weekField] = parts;
  const minutes = formatCronField(minuteField, 0, 59);
  const hours = formatCronField(hourField, 0, 23);
  const days = formatCronField(dayField, 1, 31);
  const months = formatCronField(monthField, 1, 12);
  const weeks = formatCronField(weekField, 0, 6);

  const start = new Date(afterTs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60 * 2; i += 1) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (!minutes.has(candidate.getMinutes())) continue;
    if (!hours.has(candidate.getHours())) continue;
    if (!days.has(candidate.getDate())) continue;
    if (!months.has(candidate.getMonth() + 1)) continue;
    if (!weeks.has(candidate.getDay())) continue;
    return candidate.toISOString();
  }

  throw new Error("cron_next_run_not_found");
}

export function computeNextRunAt(task: CronTaskRecord, referenceTs: number) {
  if (task.completedAt || !task.enabled) return undefined;

  if (task.termination?.stopAt) {
    const stopTs = Date.parse(task.termination.stopAt);
    if (Number.isFinite(stopTs) && referenceTs > stopTs) return undefined;
  }
  if (task.termination?.maxRuns && task.runCount >= task.termination.maxRuns)
    return undefined;

  if (task.trigger.kind === "once") {
    const runTs = Date.parse(task.trigger.runAt);
    if (!Number.isFinite(runTs) || runTs <= referenceTs || task.runCount > 0)
      return undefined;
    return new Date(runTs).toISOString();
  }

  if (task.trigger.kind === "cron") {
    return nextCronAt(task.trigger.expression, referenceTs);
  }

  const intervalMs = Math.max(1_000, Number(task.trigger.intervalMs || 0));
  if (task.lastStartedAt) {
    return new Date(Date.parse(task.lastStartedAt) + intervalMs).toISOString();
  }
  const startTs = task.trigger.startAt
    ? Date.parse(task.trigger.startAt)
    : referenceTs;
  return new Date(
    Number.isFinite(startTs) ? startTs : referenceTs,
  ).toISOString();
}
