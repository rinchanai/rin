import fs from "node:fs";
import path from "node:path";

import { readJsonFile } from "../platform/fs.js";
import { resolveInstallRecordTargetFromCandidates } from "./install-record.js";
import {
  installDirFromManagedLaunchdPlist,
  installDirFromManagedSystemdUnit,
  installDiscoveryHomeRoots,
  installRecordSourcesForHome,
  isManagedLaunchdPlistName,
  isManagedSystemdUnitName,
  launchAgentsDirForHome,
  systemdUserUnitDirForHome,
} from "./paths.js";

export type InstalledTarget = {
  targetUser: string;
  installDir: string;
  ownerHome: string;
  source: "manifest" | "systemd" | "launchd" | "launcher";
};

type ManagedInstallDiscovery = {
  source: Extract<InstalledTarget["source"], "systemd" | "launchd">;
  dirForHome: (home: string) => string;
  isManagedName: (name: string) => boolean;
  installDirFromText: (text: string) => string;
};

const MANAGED_INSTALL_DISCOVERY: ManagedInstallDiscovery[] = [
  {
    source: "systemd",
    dirForHome: systemdUserUnitDirForHome,
    isManagedName: isManagedSystemdUnitName,
    installDirFromText: installDirFromManagedSystemdUnit,
  },
  {
    source: "launchd",
    dirForHome: launchAgentsDirForHome,
    isManagedName: isManagedLaunchdPlistName,
    installDirFromText: installDirFromManagedLaunchdPlist,
  },
];

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

  const addInstallRecordTarget = (
    homeDir: string,
    userName: string,
    source: Extract<InstalledTarget["source"], "manifest" | "launcher">,
    filePaths: string[],
  ) => {
    const target = resolveInstallRecordTargetFromCandidates(
      homeDir,
      userName,
      filePaths,
      (filePath) => readJsonFile<any>(filePath, null),
    );
    if (!target) return;
    add(target.targetUser, target.installDir, homeDir, source);
  };

  const addManagedInstallTargets = (homeDir: string, userName: string) => {
    for (const discovery of MANAGED_INSTALL_DISCOVERY) {
      const installDirPath = discovery.dirForHome(homeDir);
      try {
        for (const entry of fs.readdirSync(installDirPath)) {
          if (!discovery.isManagedName(entry)) continue;
          const filePath = path.join(installDirPath, entry);
          const installDir = discovery.installDirFromText(
            fs.readFileSync(filePath, "utf8"),
          );
          if (!installDir) continue;
          add(userName, installDir, homeDir, discovery.source);
        }
      } catch {}
    }
  };

  const scanHome = (homeDir: string) => {
    const userName = path.basename(homeDir);

    for (const { source, filePaths } of installRecordSourcesForHome(homeDir)) {
      addInstallRecordTarget(homeDir, userName, source, filePaths);
    }

    addManagedInstallTargets(homeDir, userName);
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
