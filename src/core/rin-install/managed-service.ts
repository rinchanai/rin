function normalizeCommandText(value: unknown) {
  return String(value ?? "").trim();
}

function firstNonEmptyCommandText(...values: unknown[]) {
  for (const value of values) {
    const text = normalizeCommandText(value);
    if (text) return text;
  }
  return "";
}

function commandErrorText(error: unknown) {
  return firstNonEmptyCommandText(
    (error as any)?.stdout,
    (error as any)?.stderr,
    (error as any)?.message,
  );
}

function nonEmptyLines(text: string, limit: number, fromEnd = false) {
  const lines = normalizeCommandText(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return fromEnd ? lines.slice(-limit) : lines.slice(0, limit);
}

export type ManagedSystemdSnapshot = {
  unit: string;
  lines: string[];
};

type ManagedSystemdSnapshotCandidate = ManagedSystemdSnapshot & {
  score: number;
};

function pickBetterSnapshot(
  current: ManagedSystemdSnapshotCandidate | null,
  candidate: ManagedSystemdSnapshotCandidate | null,
) {
  if (!candidate) return current;
  if (!current) return candidate;
  if (candidate.score > current.score) return candidate;
  if (candidate.score < current.score) return current;
  if (candidate.lines.length > current.lines.length) return candidate;
  return current;
}

function buildManagedSystemdSnapshotCandidate(
  unit: string,
  text: string,
  lineLimit: number,
  options: { fromEnd?: boolean; score: number },
): ManagedSystemdSnapshotCandidate | null {
  const lines = nonEmptyLines(text, lineLimit, options.fromEnd);
  if (!lines.length) return null;
  return { unit, lines, score: options.score };
}

function findManagedSystemdSnapshot(
  units: string[],
  capture: (unit: string) => string,
  options: {
    lineLimit?: number;
    fromEnd?: boolean;
    includeErrors?: boolean;
    successScore?: number;
    errorScore?: number;
  } = {},
): ManagedSystemdSnapshot | null {
  let best: ManagedSystemdSnapshotCandidate | null = null;
  const lineLimit = options.lineLimit ?? 20;
  for (const unit of units) {
    try {
      best = pickBetterSnapshot(
        best,
        buildManagedSystemdSnapshotCandidate(unit, capture(unit), lineLimit, {
          fromEnd: options.fromEnd,
          score: options.successScore ?? 1,
        }),
      );
    } catch (error) {
      if (!options.includeErrors) continue;
      best = pickBetterSnapshot(
        best,
        buildManagedSystemdSnapshotCandidate(
          unit,
          commandErrorText(error),
          lineLimit,
          {
            fromEnd: options.fromEnd,
            score: options.errorScore ?? 0,
          },
        ),
      );
    }
  }
  return best ? { unit: best.unit, lines: best.lines } : null;
}

export function findManagedSystemdStatusSnapshot(
  units: string[],
  captureStatus: (unit: string) => string,
  lineLimit = 20,
): ManagedSystemdSnapshot | null {
  return findManagedSystemdSnapshot(units, captureStatus, {
    lineLimit,
    includeErrors: true,
    successScore: 2,
    errorScore: 1,
  });
}

export function findManagedSystemdJournalSnapshot(
  units: string[],
  captureJournal: (unit: string) => string,
  lineLimit = 20,
): ManagedSystemdSnapshot | null {
  return findManagedSystemdSnapshot(units, captureJournal, {
    lineLimit,
    fromEnd: true,
  });
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
