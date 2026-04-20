import { loadFirstValidCandidate } from "./candidate-loader.js";
import { defaultInstallDirForHome } from "./paths.js";

export type InstallRecord = {
  defaultTargetUser?: string;
  defaultInstallDir?: string;
};

function normalizeInstallRecordField(value: unknown) {
  return String(value ?? "").trim();
}

function resolveInstallRecordFields(home: string, value: Record<string, unknown>) {
  const defaultTargetUser =
    normalizeInstallRecordField(value.defaultTargetUser) ||
    normalizeInstallRecordField(value.targetUser);
  const defaultInstallDir =
    normalizeInstallRecordField(value.defaultInstallDir) ||
    normalizeInstallRecordField(value.installDir);
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
  return resolveInstallRecordFields(home, raw as Record<string, unknown>);
}

function resolveInstallRecordTargetFromRecord(
  home: string,
  fallbackUser: string,
  record: InstallRecord | null,
) {
  if (!record) return null;
  const targetUser =
    normalizeInstallRecordField(record.defaultTargetUser) ||
    normalizeInstallRecordField(fallbackUser);
  const installDir =
    normalizeInstallRecordField(record.defaultInstallDir) ||
    defaultInstallDirForHome(home);
  if (!targetUser || !installDir) return null;
  return { targetUser, installDir };
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
