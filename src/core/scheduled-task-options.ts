export const SCHEDULED_TASK_TRIGGER_KINDS = [
  "interval",
  "cron",
  "once",
] as const;

export const SCHEDULED_TASK_TARGET_KINDS = [
  "agent_prompt",
  "shell_command",
] as const;

export const SCHEDULED_TASK_SESSION_MODES = [
  "current",
  "dedicated",
  "ephemeral",
] as const;

export const DEFAULT_SCHEDULED_TASK_SESSION_MODE = "ephemeral";

export type ScheduledTaskTriggerKind =
  (typeof SCHEDULED_TASK_TRIGGER_KINDS)[number];

export type ScheduledTaskTargetKind =
  (typeof SCHEDULED_TASK_TARGET_KINDS)[number];

export type ScheduledTaskSessionMode =
  (typeof SCHEDULED_TASK_SESSION_MODES)[number];

export function isScheduledTaskSessionMode(
  value: unknown,
): value is ScheduledTaskSessionMode {
  return SCHEDULED_TASK_SESSION_MODES.includes(
    value as ScheduledTaskSessionMode,
  );
}
