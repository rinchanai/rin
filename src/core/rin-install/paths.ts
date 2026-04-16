import path from "node:path";

export function defaultInstallDirForHome(homeDir: string) {
  return path.join(homeDir, ".rin");
}

export function appConfigDirForHome(homeDir: string) {
  if (process.platform === "darwin")
    return path.join(homeDir, "Library", "Application Support", "rin");
  return path.join(homeDir, ".config", "rin");
}

export function appConfigDirForUser(
  userName: string,
  homeForUser: (user: string) => string,
) {
  return appConfigDirForHome(homeForUser(userName));
}

export function launcherMetadataPathForHome(homeDir: string) {
  return path.join(appConfigDirForHome(homeDir), "install.json");
}

export function launcherMetadataCandidatePathsForHome(homeDir: string) {
  return [
    path.join(homeDir, ".config", "rin", "install.json"),
    path.join(homeDir, "Library", "Application Support", "rin", "install.json"),
  ];
}

export function installerManifestPathsForInstallDir(installDir: string) {
  return [
    path.join(installDir, "installer.json"),
    path.join(installDir, "config", "installer.json"),
  ] as const;
}

export function installerManifestPathsForHome(homeDir: string) {
  return installerManifestPathsForInstallDir(defaultInstallDirForHome(homeDir));
}
