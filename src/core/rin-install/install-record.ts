import { defaultInstallDirForHome } from "./paths.js";

export type InstallRecord = {
  defaultTargetUser?: string;
  defaultInstallDir?: string;
};

export function normalizeInstallRecord(
  home: string,
  raw: unknown,
): InstallRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const defaultTargetUser = String(value.defaultTargetUser || "").trim();
  const defaultInstallDir = String(value.defaultInstallDir || "").trim();
  if (defaultTargetUser || defaultInstallDir) {
    return {
      defaultTargetUser,
      defaultInstallDir,
    };
  }
  const targetUser = String(value.targetUser || "").trim();
  const installDir = String(value.installDir || "").trim();
  if (!targetUser && !installDir) return null;
  return {
    defaultTargetUser: targetUser,
    defaultInstallDir: installDir || defaultInstallDirForHome(home),
  };
}

export function loadInstallRecordFromCandidates(
  home: string,
  filePaths: string[],
  readCandidate: (filePath: string) => unknown,
) {
  for (const filePath of filePaths) {
    try {
      const record = normalizeInstallRecord(home, readCandidate(filePath));
      if (record) return record;
    } catch {}
  }
  return null;
}

export function resolveInstallRecordTarget(
  home: string,
  fallbackUser: string,
  raw: unknown,
) {
  const record = normalizeInstallRecord(home, raw);
  if (!record) return null;
  const targetUser = String(record.defaultTargetUser || fallbackUser).trim();
  const installDir = String(
    record.defaultInstallDir || defaultInstallDirForHome(home),
  ).trim();
  if (!targetUser || !installDir) return null;
  return { targetUser, installDir };
}

export function resolveInstallRecordTargetFromCandidates(
  home: string,
  fallbackUser: string,
  filePaths: string[],
  readCandidate: (filePath: string) => unknown,
) {
  const record = loadInstallRecordFromCandidates(home, filePaths, readCandidate);
  if (!record) return null;
  const targetUser = String(record.defaultTargetUser || fallbackUser).trim();
  const installDir = String(
    record.defaultInstallDir || defaultInstallDirForHome(home),
  ).trim();
  if (!targetUser || !installDir) return null;
  return { targetUser, installDir };
}
