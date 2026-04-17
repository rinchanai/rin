import fs from "node:fs";
import path from "node:path";

import {
  defaultInstallDirForHome,
  installerManifestPath,
  legacyInstallerManifestPath,
} from "./paths.js";

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function installDirFromSystemdUnit(text: string) {
  const match = text.match(/^Environment=RIN_DIR=(.+)$/m);
  return String(match?.[1] || "").trim();
}

function installDirFromLaunchdPlist(text: string) {
  const match = text.match(/<key>RIN_DIR<\/key>\s*<string>([^<]+)<\/string>/);
  return String(match?.[1] || "").trim();
}

export type InstalledTarget = {
  targetUser: string;
  installDir: string;
  ownerHome: string;
  source: "manifest" | "systemd" | "launchd";
};

export function discoverInstalledTargets(homeRoots = ["/home", "/Users"]) {
  const rows: InstalledTarget[] = [];
  const seen = new Set<string>();

  const add = (
    targetUser: string,
    installDir: string,
    ownerHome: string,
    source: InstalledTarget["source"],
  ) => {
    const nextTargetUser = String(targetUser || "").trim();
    const nextInstallDir = String(installDir || "").trim();
    const nextOwnerHome = String(ownerHome || "").trim();
    if (!nextTargetUser || !nextInstallDir || !nextOwnerHome) return;
    const key = `${nextTargetUser}\t${nextInstallDir}\t${nextOwnerHome}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      targetUser: nextTargetUser,
      installDir: nextInstallDir,
      ownerHome: nextOwnerHome,
      source,
    });
  };

  const scanHome = (homeDir: string) => {
    const userName = path.basename(homeDir);
    const defaultInstallDir = defaultInstallDirForHome(homeDir);
    const manifest = readJsonFile<any>(
      installerManifestPath(defaultInstallDir),
      readJsonFile<any>(legacyInstallerManifestPath(defaultInstallDir), null),
    );
    if (manifest && typeof manifest === "object") {
      add(
        String(manifest.targetUser || userName),
        String(manifest.installDir || defaultInstallDir),
        homeDir,
        "manifest",
      );
    }

    const systemdDir = path.join(homeDir, ".config", "systemd", "user");
    try {
      for (const entry of fs.readdirSync(systemdDir)) {
        if (!/^rin-daemon(?:-.+)?\.service$/.test(entry)) continue;
        const filePath = path.join(systemdDir, entry);
        const installDir = installDirFromSystemdUnit(
          fs.readFileSync(filePath, "utf8"),
        );
        if (!installDir) continue;
        add(userName, installDir, homeDir, "systemd");
      }
    } catch {}

    const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
    try {
      for (const entry of fs.readdirSync(launchAgentsDir)) {
        if (!/^com\.rin\.daemon\..+\.plist$/.test(entry)) continue;
        const filePath = path.join(launchAgentsDir, entry);
        const installDir = installDirFromLaunchdPlist(
          fs.readFileSync(filePath, "utf8"),
        );
        if (!installDir) continue;
        add(userName, installDir, homeDir, "launchd");
      }
    } catch {}
  };

  for (const root of homeRoots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        scanHome(path.join(root, entry.name));
      }
    } catch {}
  }

  return rows.sort(
    (a, b) =>
      a.targetUser.localeCompare(b.targetUser) ||
      a.installDir.localeCompare(b.installDir) ||
      a.ownerHome.localeCompare(b.ownerHome),
  );
}
