import path from "node:path";

const INSTALLED_APP_ENTRY_FILES = {
  rin: ["rin", "main.js"],
  "rin-daemon": ["rin-daemon", "daemon.js"],
  "rin-install": ["rin-install", "main.js"],
} as const;

export type InstalledAppKey = keyof typeof INSTALLED_APP_ENTRY_FILES;

export function defaultInstallDirForHome(home: string) {
  return path.join(home, ".rin");
}

export function installAppRoot(installDir: string) {
  return path.join(installDir, "app");
}

export function currentRuntimeRoot(installDir: string) {
  return path.join(installAppRoot(installDir), "current");
}

export function installedReleasesRoot(installDir: string) {
  return path.join(installAppRoot(installDir), "releases");
}

export function installedReleaseRoot(installDir: string, releaseId: string) {
  return path.join(installedReleasesRoot(installDir), releaseId);
}

export function currentInstalledAppEntryPath(
  installDir: string,
  app: InstalledAppKey,
) {
  return path.join(
    currentRuntimeRoot(installDir),
    "dist",
    "app",
    ...INSTALLED_APP_ENTRY_FILES[app],
  );
}

export function legacyInstalledAppEntryPath(
  installDir: string,
  app: InstalledAppKey,
) {
  if (app === "rin") {
    return path.join(currentRuntimeRoot(installDir), "dist", "index.js");
  }
  if (app === "rin-daemon") {
    return path.join(currentRuntimeRoot(installDir), "dist", "daemon.js");
  }
  return "";
}

export function installedAppEntryCandidates(
  installDir: string,
  app: InstalledAppKey,
) {
  const legacyPath = legacyInstalledAppEntryPath(installDir, app);
  return [currentInstalledAppEntryPath(installDir, app), legacyPath].filter(
    Boolean,
  );
}

export function sourceAppEntryPath(sourceRoot: string, app: InstalledAppKey) {
  return path.join(
    sourceRoot,
    "dist",
    "app",
    ...INSTALLED_APP_ENTRY_FILES[app],
  );
}

export function installerManifestPath(installDir: string) {
  return path.join(installDir, "installer.json");
}

export function legacyInstallerManifestPath(installDir: string) {
  return path.join(installDir, "config", "installer.json");
}

export function installerLocatorPathForHome(home: string) {
  return installerManifestPath(defaultInstallDirForHome(home));
}

export function legacyInstallerLocatorPathForHome(home: string) {
  return legacyInstallerManifestPath(defaultInstallDirForHome(home));
}
