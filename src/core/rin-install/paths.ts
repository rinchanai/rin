import path from "node:path";

export function defaultInstallDirForHome(home: string) {
  return path.join(home, ".rin");
}

export function installerManifestPath(installDir: string) {
  return path.join(installDir, "installer.json");
}

export function legacyInstallerManifestPath(installDir: string) {
  return path.join(installDir, "config", "installer.json");
}
