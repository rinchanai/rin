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

type InstallRecordSource = Extract<
  InstalledTarget["source"],
  "manifest" | "launcher"
>;

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

function normalizeInstalledTarget(
  targetUser: unknown,
  installDir: unknown,
  ownerHome: unknown,
  source: InstalledTarget["source"],
): InstalledTarget | null {
  const nextTargetUser = String(targetUser || "").trim();
  const nextInstallDir = String(installDir || "").trim();
  const nextOwnerHome = String(ownerHome || "").trim();
  if (!nextTargetUser || !nextInstallDir || !nextOwnerHome) return null;
  return {
    targetUser: nextTargetUser,
    installDir: nextInstallDir,
    ownerHome: nextOwnerHome,
    source,
  };
}

function installedTargetKey(target: InstalledTarget) {
  return `${target.targetUser}\t${target.installDir}\t${target.ownerHome}`;
}

function addInstalledTarget(
  rows: InstalledTarget[],
  seen: Set<string>,
  target: InstalledTarget | null,
) {
  if (!target) return;
  const key = installedTargetKey(target);
  if (seen.has(key)) return;
  seen.add(key);
  rows.push(target);
}

function readDirectoryNames(dir: string) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readDirectoryEntries(dir: string) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readUtf8File(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function discoverInstallRecordTarget(
  homeDir: string,
  userName: string,
  source: InstallRecordSource,
  filePaths: string[],
) {
  const target = resolveInstallRecordTargetFromCandidates(
    homeDir,
    userName,
    filePaths,
    (filePath) => readJsonFile<any>(filePath, null),
  );
  return normalizeInstalledTarget(
    target?.targetUser,
    target?.installDir,
    homeDir,
    source,
  );
}

function discoverManagedInstallTargets(
  homeDir: string,
  userName: string,
  discovery: ManagedInstallDiscovery,
) {
  const installDirPath = discovery.dirForHome(homeDir);
  const rows: InstalledTarget[] = [];
  for (const entry of readDirectoryNames(installDirPath)) {
    if (!discovery.isManagedName(entry)) continue;
    const installDir = discovery.installDirFromText(
      readUtf8File(path.join(installDirPath, entry)),
    );
    const target = normalizeInstalledTarget(
      userName,
      installDir,
      homeDir,
      discovery.source,
    );
    if (target) rows.push(target);
  }
  return rows;
}

function compareInstalledTargets(a: InstalledTarget, b: InstalledTarget) {
  return (
    a.targetUser.localeCompare(b.targetUser) ||
    a.installDir.localeCompare(b.installDir) ||
    a.ownerHome.localeCompare(b.ownerHome)
  );
}

export function discoverInstalledTargets(
  homeRoots = installDiscoveryHomeRoots(),
) {
  const rows: InstalledTarget[] = [];
  const seen = new Set<string>();

  for (const root of homeRoots) {
    for (const entry of readDirectoryEntries(root)) {
      if (!entry.isDirectory()) continue;
      const homeDir = path.join(root, entry.name);
      const userName = entry.name;

      for (const { source, filePaths } of installRecordSourcesForHome(
        homeDir,
      )) {
        addInstalledTarget(
          rows,
          seen,
          discoverInstallRecordTarget(homeDir, userName, source, filePaths),
        );
      }

      for (const discovery of MANAGED_INSTALL_DISCOVERY) {
        for (const target of discoverManagedInstallTargets(
          homeDir,
          userName,
          discovery,
        )) {
          addInstalledTarget(rows, seen, target);
        }
      }
    }
  }

  return rows.sort(compareInstalledTargets);
}
