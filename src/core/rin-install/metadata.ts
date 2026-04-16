import {
  defaultInstallDirForHome,
  installerManifestPathsForHome,
  launcherMetadataCandidatePathsForHome,
} from "./paths.js";

export type LauncherMetadata = {
  defaultTargetUser?: string;
  defaultInstallDir?: string;
  installedBy?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

export type InstallerManifest = {
  targetUser?: string;
  installDir?: string;
  [key: string]: unknown;
};

export type InstalledTargetMetadata = {
  targetUser: string;
  installDir: string;
};

function trimmed(value: unknown) {
  return String(value || "").trim();
}

function resolvedField(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
) {
  if (!Object.hasOwn(record, key)) return fallback;
  const value = trimmed(record[key]);
  return value || null;
}

export function readLauncherMetadataFromHome<T>(
  homeDir: string,
  readJsonFile: (filePath: string, fallback: T) => T,
  fallback: T,
) {
  const [primaryPath, secondaryPath] =
    launcherMetadataCandidatePathsForHome(homeDir);
  const missing = Symbol("missing_launcher_metadata");
  const readAny = readJsonFile as (
    filePath: string,
    fallback: unknown,
  ) => unknown;
  const primaryValue = readAny(primaryPath, missing) as T | symbol;
  if (primaryValue !== missing) return primaryValue;
  return readJsonFile(secondaryPath, fallback);
}

export function readInstallerManifestFromHome<T>(
  homeDir: string,
  readJsonFile: (filePath: string, fallback: T) => T,
  fallback: T,
) {
  const [manifestPath, legacyManifestPath] =
    installerManifestPathsForHome(homeDir);
  const missing = Symbol("missing_installer_manifest");
  const readAny = readJsonFile as (
    filePath: string,
    fallback: unknown,
  ) => unknown;
  const primaryValue = readAny(manifestPath, missing) as T | symbol;
  if (primaryValue !== missing) return primaryValue;
  return readJsonFile(legacyManifestPath, fallback);
}

export function installedTargetFromLauncherMetadata(
  launcherMetadata: LauncherMetadata | null | undefined,
  userName: string,
  homeDir: string,
): InstalledTargetMetadata | null {
  if (!launcherMetadata || typeof launcherMetadata !== "object") return null;
  const targetUser = resolvedField(
    launcherMetadata,
    "defaultTargetUser",
    userName,
  );
  const installDir = resolvedField(
    launcherMetadata,
    "defaultInstallDir",
    defaultInstallDirForHome(homeDir),
  );
  if (!targetUser || !installDir) return null;
  return { targetUser, installDir };
}

export function installedTargetFromManifest(
  manifest: InstallerManifest | null | undefined,
  userName: string,
  homeDir: string,
): InstalledTargetMetadata | null {
  if (!manifest || typeof manifest !== "object") return null;
  const targetUser = resolvedField(manifest, "targetUser", userName);
  const installDir = resolvedField(
    manifest,
    "installDir",
    defaultInstallDirForHome(homeDir),
  );
  if (!targetUser || !installDir) return null;
  return { targetUser, installDir };
}

export function nextLauncherMetadata(
  existing: LauncherMetadata | null | undefined,
  options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    updatedAt?: string;
  },
): LauncherMetadata {
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    defaultTargetUser: options.targetUser,
    defaultInstallDir: options.installDir,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
    installedBy: options.currentUser,
  };
}
