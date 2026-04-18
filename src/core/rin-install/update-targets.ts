import fs from "node:fs";
import path from "node:path";

import { readJsonFile } from "../platform/fs.js";
import { resolveInstallRecordTargetFromCandidates } from "./install-record.js";
import {
  installDirFromManagedLaunchdPlist,
  installDirFromManagedSystemdUnit,
  installDiscoveryHomeRoots,
  installerLocatorCandidatesForHome,
  isManagedLaunchdPlistName,
  isManagedSystemdUnitName,
  launchAgentsDirForHome,
  launcherMetadataCandidatesForHome,
  systemdUserUnitDirForHome,
} from "./paths.js";

export type InstalledTarget = {
  targetUser: string;
  installDir: string;
  ownerHome: string;
  source: "manifest" | "systemd" | "launchd" | "launcher";
};

export function discoverInstalledTargets(
  homeRoots = installDiscoveryHomeRoots(),
) {
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
    const manifestTarget = resolveInstallRecordTargetFromCandidates(
      homeDir,
      userName,
      installerLocatorCandidatesForHome(homeDir),
      (filePath) => readJsonFile<any>(filePath, null),
    );
    if (manifestTarget) {
      add(
        manifestTarget.targetUser,
        manifestTarget.installDir,
        homeDir,
        "manifest",
      );
    }

    const systemdDir = systemdUserUnitDirForHome(homeDir);
    try {
      for (const entry of fs.readdirSync(systemdDir)) {
        if (!isManagedSystemdUnitName(entry)) continue;
        const filePath = path.join(systemdDir, entry);
        const installDir = installDirFromManagedSystemdUnit(
          fs.readFileSync(filePath, "utf8"),
        );
        if (!installDir) continue;
        add(userName, installDir, homeDir, "systemd");
      }
    } catch {}

    const launchAgentsDir = launchAgentsDirForHome(homeDir);
    try {
      for (const entry of fs.readdirSync(launchAgentsDir)) {
        if (!isManagedLaunchdPlistName(entry)) continue;
        const filePath = path.join(launchAgentsDir, entry);
        const installDir = installDirFromManagedLaunchdPlist(
          fs.readFileSync(filePath, "utf8"),
        );
        if (!installDir) continue;
        add(userName, installDir, homeDir, "launchd");
      }
    } catch {}

    const launcherTarget = resolveInstallRecordTargetFromCandidates(
      homeDir,
      userName,
      launcherMetadataCandidatesForHome(homeDir),
      (filePath) => readJsonFile<any>(filePath, null),
    );
    if (launcherTarget) {
      add(
        launcherTarget.targetUser,
        launcherTarget.installDir,
        homeDir,
        "launcher",
      );
    }
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
