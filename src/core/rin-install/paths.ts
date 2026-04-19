import path from "node:path";

const INSTALLED_APP_ENTRY_LAYOUT = {
  rin: {
    current: ["app", "rin", "main.js"],
    legacy: ["index.js"],
  },
  "rin-daemon": {
    current: ["app", "rin-daemon", "daemon.js"],
    legacy: ["daemon.js"],
  },
  "rin-install": {
    current: ["app", "rin-install", "main.js"],
  },
} as const;

export type InstalledAppKey = keyof typeof INSTALLED_APP_ENTRY_LAYOUT;

function uniqueNonEmptyStrings(values: Array<string | undefined | null>) {
  return Array.from(
    new Set(values.map((value) => String(value || "").trim()).filter(Boolean)),
  );
}

export function defaultHomeRoot(platform = process.platform) {
  return platform === "darwin" ? "/Users" : "/home";
}

export function installDiscoveryHomeRoots() {
  return uniqueNonEmptyStrings([
    defaultHomeRoot("linux"),
    defaultHomeRoot("darwin"),
  ]);
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

function installedAppDistRoot(installDir: string) {
  return path.join(currentRuntimeRoot(installDir), "dist");
}

function installedAppEntryPathFromSegments(
  installDir: string,
  segments?: readonly string[],
) {
  return segments?.length
    ? path.join(installedAppDistRoot(installDir), ...segments)
    : "";
}

export function currentInstalledAppEntryPath(
  installDir: string,
  app: InstalledAppKey,
) {
  return installedAppEntryPathFromSegments(
    installDir,
    INSTALLED_APP_ENTRY_LAYOUT[app].current,
  );
}

export function legacyInstalledAppEntryPath(
  installDir: string,
  app: InstalledAppKey,
) {
  const layout = INSTALLED_APP_ENTRY_LAYOUT[app];
  return installedAppEntryPathFromSegments(
    installDir,
    "legacy" in layout ? layout.legacy : undefined,
  );
}

export function installedAppEntryCandidates(
  installDir: string,
  app: InstalledAppKey,
) {
  return uniqueNonEmptyStrings([
    currentInstalledAppEntryPath(installDir, app),
    legacyInstalledAppEntryPath(installDir, app),
  ]);
}

export function resolveInstalledAppEntryPath(
  installDir: string,
  app: InstalledAppKey,
  pathExists: (candidate: string) => boolean,
) {
  for (const candidate of installedAppEntryCandidates(installDir, app)) {
    if (pathExists(candidate)) return candidate;
  }
  return null;
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

export function installerManifestPaths(installDir: string, home: string) {
  const manifestPath = installerManifestPath(installDir);
  const locatorManifestPath = installerLocatorPathForHome(home);
  const legacyManifestPath = legacyInstallerManifestPath(installDir);
  const legacyLocatorManifestPath = legacyInstallerLocatorPathForHome(home);
  return {
    manifestPath,
    locatorManifestPath,
    legacyManifestPath,
    legacyLocatorManifestPath,
    writePaths: uniqueNonEmptyStrings([manifestPath, locatorManifestPath]),
    cleanupPaths: uniqueNonEmptyStrings([
      legacyManifestPath,
      legacyLocatorManifestPath,
    ]),
    recoveryPaths: uniqueNonEmptyStrings([
      manifestPath,
      locatorManifestPath,
      legacyManifestPath,
      legacyLocatorManifestPath,
    ]),
  };
}

export function installerLocatorCandidatesForHome(home: string) {
  return installerManifestPaths(defaultInstallDirForHome(home), home)
    .recoveryPaths;
}

export function installerRecoveryManifestCandidates(
  installDir: string,
  home: string,
) {
  return installerManifestPaths(installDir, home).recoveryPaths;
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

export function launcherMetadataCandidatesForHome(home: string) {
  return uniqueNonEmptyStrings([
    launcherMetadataPathForHome(home),
    launcherMetadataPathForHome(
      home,
      process.platform === "darwin" ? "linux" : "darwin",
    ),
  ]);
}

export type InstallRecordSource = "manifest" | "launcher";

export type InstallRecordSourceCandidate = {
  source: InstallRecordSource;
  filePaths: string[];
};

export function installRecordSourcesForHome(
  home: string,
): InstallRecordSourceCandidate[] {
  const manifestFilePaths = installerLocatorCandidatesForHome(home);
  const launcherFilePaths = launcherMetadataCandidatesForHome(home);
  return [
    { source: "manifest", filePaths: manifestFilePaths },
    { source: "launcher", filePaths: launcherFilePaths },
  ];
}

export function installRecordCandidatesForHome(home: string) {
  const [manifestSource, launcherSource] = installRecordSourcesForHome(home);
  return uniqueNonEmptyStrings([
    ...launcherSource.filePaths,
    ...manifestSource.filePaths,
  ]);
}

const LEGACY_MANAGED_SYSTEMD_UNIT_NAME = "rin-daemon.service";

function managedSystemdUnitUserFragment(targetUser: string) {
  return String(targetUser).replace(/[^A-Za-z0-9_.@-]+/g, "-");
}

function managedLaunchdUserFragment(targetUser: string) {
  return String(targetUser).replace(/[^A-Za-z0-9_.-]+/g, "-");
}

export function managedSystemdUnitName(targetUser: string) {
  return `rin-daemon-${managedSystemdUnitUserFragment(targetUser)}.service`;
}

export function managedSystemdUnitCandidates(targetUser: string) {
  return uniqueNonEmptyStrings([
    managedSystemdUnitName(targetUser),
    LEGACY_MANAGED_SYSTEMD_UNIT_NAME,
  ]);
}

export function isManagedSystemdUnitName(unitName: string) {
  return (
    unitName === LEGACY_MANAGED_SYSTEMD_UNIT_NAME ||
    /^rin-daemon(?:-.+)?\.service$/.test(unitName)
  );
}

export function installDirFromManagedSystemdUnit(text: string) {
  const match = text.match(/^Environment=RIN_DIR=(.+)$/m);
  return String(match?.[1] || "").trim();
}

export function managedLaunchdLabel(targetUser: string) {
  return `com.rin.daemon.${managedLaunchdUserFragment(targetUser)}`;
}

export function managedLaunchdPlistName(targetUser: string) {
  return `${managedLaunchdLabel(targetUser)}.plist`;
}

export function isManagedLaunchdPlistName(fileName: string) {
  return /^com\.rin\.daemon\..+\.plist$/.test(fileName);
}

export function installDirFromManagedLaunchdPlist(text: string) {
  const match = text.match(/<key>RIN_DIR<\/key>\s*<string>([^<]+)<\/string>/);
  return String(match?.[1] || "").trim();
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
