function commandErrorText(error: unknown) {
  const output = String(
    (error as any)?.stdout ||
      (error as any)?.stderr ||
      (error as any)?.message ||
      "",
  ).trim();
  return output;
}

function nonEmptyLines(text: string, limit: number, fromEnd = false) {
  const lines = String(text || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return fromEnd ? lines.slice(-limit) : lines.slice(0, limit);
}

export type ManagedSystemdSnapshot = {
  unit: string;
  lines: string[];
};

export function findManagedSystemdStatusSnapshot(
  units: string[],
  captureStatus: (unit: string) => string,
  lineLimit = 20,
): ManagedSystemdSnapshot | null {
  for (const unit of units) {
    try {
      const lines = nonEmptyLines(captureStatus(unit), lineLimit);
      if (lines.length > 0) return { unit, lines };
    } catch (error) {
      const lines = nonEmptyLines(commandErrorText(error), lineLimit);
      if (lines.length > 0) return { unit, lines };
    }
  }
  return null;
}

export function findManagedSystemdJournalSnapshot(
  units: string[],
  captureJournal: (unit: string) => string,
  lineLimit = 20,
): ManagedSystemdSnapshot | null {
  for (const unit of units) {
    try {
      const lines = nonEmptyLines(captureJournal(unit), lineLimit, true);
      if (lines.length > 0) return { unit, lines };
    } catch {}
  }
  return null;
}

export function tryManagedSystemdAction(
  units: string[],
  options: {
    daemonReload?: () => void;
    probeUnit?: (unit: string) => void;
    runAction: (unit: string) => void;
  },
) {
  try {
    options.daemonReload?.();
  } catch {}
  for (const unit of units) {
    try {
      options.probeUnit?.(unit);
      options.runAction(unit);
      return unit;
    } catch {}
  }
  return null;
}
