export const SCHEDULED_TASK_SESSION_MODES = [
  "current",
  "dedicated",
  "ephemeral",
] as const;

export type ScheduledTaskSessionMode =
  (typeof SCHEDULED_TASK_SESSION_MODES)[number];

export function isScheduledTaskSessionMode(
  value: unknown,
): value is ScheduledTaskSessionMode {
  return SCHEDULED_TASK_SESSION_MODES.includes(
    value as ScheduledTaskSessionMode,
  );
}
