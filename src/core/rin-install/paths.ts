import path from "node:path";

const INSTALLED_APP_ENTRY_FILES = {
  rin: ["rin", "main.js"],
  "rin-daemon": ["rin-daemon", "daemon.js"],
  "rin-install": ["rin-install", "main.js"],
} as const;

export type InstalledAppKey = keyof typeof INSTALLED_APP_ENTRY_FILES;

export function defaultHomeRoot(platform = process.platform) {
  return platform === "darwin" ? "/Users" : "/home";
}

export function installDiscoveryHomeRoots() {
  return [...new Set([defaultHomeRoot("linux"), defaultHomeRoot("darwin")])];
}

export function defaultHomeForUser(user: string, platform = process.platform) {
  return path.join(defaultHomeRoot(platform), user);
}

export function defaultInstallDirForHome(home: string) {
  return path.join(home, ".rin");
}

export function installSettingsPath(installDir: string) {
  return path.join(installDir, "settings.json");
}

export function installAuthPath(installDir: string) {
  return path.join(installDir, "auth.json");
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

export function installedDocsRoot(installDir: string) {
  return path.join(installDir, "docs");
}

export function installedRinDocsRoot(installDir: string) {
  return path.join(installedDocsRoot(installDir), "rin");
}

export function installedBuiltinSkillsRoot(installDir: string) {
  return path.join(installedRinDocsRoot(installDir), "builtin-skills");
}

export function installedBuiltinSkillRoot(
  installDir: string,
  skillName: string,
) {
  return path.join(installedBuiltinSkillsRoot(installDir), skillName);
}

export function installedPiDocsRoot(installDir: string) {
  return path.join(installedDocsRoot(installDir), "pi");
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

export function installerLocatorCandidatesForHome(home: string) {
  return [
    installerLocatorPathForHome(home),
    legacyInstallerLocatorPathForHome(home),
  ];
}

export function installerRecoveryManifestCandidates(
  installDir: string,
  home: string,
) {
  return [
    installerManifestPath(installDir),
    installerLocatorPathForHome(home),
    legacyInstallerManifestPath(installDir),
    legacyInstallerLocatorPathForHome(home),
  ];
}

export function localBinDirForHome(home: string) {
  return path.join(home, ".local", "bin");
}

export function launcherPathForHome(home: string, name: "rin" | "rin-install") {
  return path.join(localBinDirForHome(home), name);
}

export function appConfigDirForHome(home: string, platform = process.platform) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "rin");
  }
  return path.join(home, ".config", "rin");
}

export function launcherMetadataPathForHome(
  home: string,
  platform = process.platform,
) {
  return path.join(appConfigDirForHome(home, platform), "install.json");
}

export function launchAgentsDirForHome(home: string) {
  return path.join(home, "Library", "LaunchAgents");
}

export function launchAgentPlistPathForHome(home: string, label: string) {
  return path.join(launchAgentsDirForHome(home), `${label}.plist`);
}

export function systemdUserUnitDirForHome(home: string) {
  return path.join(home, ".config", "systemd", "user");
}

export function systemdUserUnitPathForHome(home: string, unitName: string) {
  return path.join(systemdUserUnitDirForHome(home), unitName);
}

export function daemonLogsDir(installDir: string) {
  return path.join(installDir, "data", "logs");
}

export function daemonStdoutLogPath(installDir: string) {
  return path.join(daemonLogsDir(installDir), "daemon.stdout.log");
}

export function daemonStderrLogPath(installDir: string) {
  return path.join(daemonLogsDir(installDir), "daemon.stderr.log");
}
