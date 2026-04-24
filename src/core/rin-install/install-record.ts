import { loadFirstValidCandidate } from "./candidate-loader.js";
import { defaultInstallDirForHome } from "./paths.js";

export type InstallRecord = {
  defaultTargetUser?: string;
  defaultInstallDir?: string;
};

function normalizeInstallRecordField(value: unknown) {
  return String(value ?? "").trim();
}

function firstInstallRecordField(...values: unknown[]) {
  for (const value of values) {
    const normalized = normalizeInstallRecordField(value);
    if (normalized) return normalized;
  }
  return "";
}

function createInstallRecord(
  home: string,
  fields: {
    defaultTargetUser?: unknown;
    defaultInstallDir?: unknown;
  },
): InstallRecord | null {
  const defaultTargetUser = firstInstallRecordField(fields.defaultTargetUser);
  const defaultInstallDir = firstInstallRecordField(fields.defaultInstallDir);
  if (!defaultTargetUser && !defaultInstallDir) return null;
  return {
    defaultTargetUser,
    defaultInstallDir: defaultInstallDir || defaultInstallDirForHome(home),
  };
}

export function normalizeInstallRecord(
  home: string,
  raw: unknown,
): InstallRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  return createInstallRecord(home, {
    defaultTargetUser: firstInstallRecordField(
      value.defaultTargetUser,
      value.targetUser,
    ),
    defaultInstallDir: firstInstallRecordField(
      value.defaultInstallDir,
      value.installDir,
    ),
  });
}

function resolveInstallRecordTargetFromRecord(
  home: string,
  fallbackUser: string,
  record: InstallRecord | null,
) {
  if (!record) return null;
  const targetUser = firstInstallRecordField(
    record.defaultTargetUser,
    fallbackUser,
  );
  const installDir = firstInstallRecordField(record.defaultInstallDir);
  if (!targetUser) return null;
  return {
    targetUser,
    installDir: installDir || defaultInstallDirForHome(home),
  };
}

export function loadInstallRecordFromCandidates(
  home: string,
  filePaths: string[],
  readCandidate: (filePath: string) => unknown,
) {
  return loadFirstValidCandidate(filePaths, readCandidate, (value) =>
    normalizeInstallRecord(home, value),
  );
}

export function resolveInstallRecordTarget(
  home: string,
  fallbackUser: string,
  raw: unknown,
) {
  return resolveInstallRecordTargetFromRecord(
    home,
    fallbackUser,
    normalizeInstallRecord(home, raw),
  );
}

export function resolveInstallRecordTargetFromCandidates(
  home: string,
  fallbackUser: string,
  filePaths: string[],
  readCandidate: (filePath: string) => unknown,
) {
  return resolveInstallRecordTargetFromRecord(
    home,
    fallbackUser,
    loadInstallRecordFromCandidates(home, filePaths, readCandidate),
  );
}
