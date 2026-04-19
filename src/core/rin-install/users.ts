import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { defaultHomeForUser } from "./paths.js";

export function listSystemUsers() {
  const users: Array<{
    name: string;
    uid: number;
    gid: number;
    home: string;
    shell: string;
  }> = [];
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("dscl", [".", "-list", "/Users", "UniqueID"], {
        encoding: "utf8",
      });
      for (const line of raw.split(/\r?\n/)) {
        const match = line.trim().match(/^(\S+)\s+(\d+)$/);
        if (!match) continue;
        const [, name, uidRaw] = match;
        const uid = Number(uidRaw || 0);
        if (!name || !Number.isFinite(uid) || uid < 500 || name === "nobody")
          continue;
        let home = "";
        let shell = "";
        let gid = 20;
        try {
          const detail = execFileSync(
            "dscl",
            [
              ".",
              "-read",
              `/Users/${name}`,
              "NFSHomeDirectory",
              "UserShell",
              "PrimaryGroupID",
            ],
            { encoding: "utf8" },
          );
          for (const detailLine of detail.split(/\r?\n/)) {
            if (detailLine.startsWith("NFSHomeDirectory:"))
              home = detailLine.replace(/^NFSHomeDirectory:\s*/, "").trim();
            if (detailLine.startsWith("UserShell:"))
              shell = detailLine.replace(/^UserShell:\s*/, "").trim();
            if (detailLine.startsWith("PrimaryGroupID:"))
              gid = Number(
                detailLine.replace(/^PrimaryGroupID:\s*/, "").trim() || 20,
              );
          }
        } catch {}
        if (/nologin|false/.test(shell)) continue;
        users.push({ name, uid, gid, home, shell });
      }
    } catch {}
    return users.sort((a, b) => a.uid - b.uid || a.name.localeCompare(b.name));
  }

  try {
    const raw = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [name = "", , uidRaw = "", gidRaw = "", , home = "", shell = ""] =
        line.split(":");
      const uid = Number(uidRaw || 0);
      const gid = Number(gidRaw || 0);
      if (
        !name ||
        !Number.isFinite(uid) ||
        !Number.isFinite(gid) ||
        uid < 1000 ||
        name === "nobody"
      )
        continue;
      if (/nologin|false/.test(shell)) continue;
      users.push({ name, uid, gid, home, shell } as any);
    }
  } catch {}
  return users.sort((a, b) => a.uid - b.uid || a.name.localeCompare(b.name));
}

export function findSystemUser(targetUser: string) {
  return listSystemUsers().find((entry) => entry.name === targetUser);
}

export function homeForUser(targetUser: string) {
  const matched = findSystemUser(targetUser);
  return matched?.home || defaultHomeForUser(targetUser);
}

export function targetHomeForUser(targetUser: string) {
  return homeForUser(targetUser);
}

export function describeOwnership(targetUser: string, installDir: string) {
  const target = findSystemUser(targetUser) as any;
  const targetUid = Number(target?.uid ?? -1);
  const targetGid = Number(target?.gid ?? -1);
  try {
    const stat = fs.statSync(installDir);
    let writable = true;
    try {
      fs.accessSync(installDir, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    return {
      ownerMatches: targetUid >= 0 ? stat.uid === targetUid : true,
      writable,
      statUid: stat.uid,
      statGid: stat.gid,
      targetUid,
      targetGid,
    };
  } catch {
    return {
      ownerMatches: true,
      writable: true,
      statUid: -1,
      statGid: -1,
      targetUid,
      targetGid,
    };
  }
}

export function shouldUseElevatedWrite(
  targetUser: string,
  ownership: ReturnType<typeof describeOwnership>,
) {
  const effectiveUser = os.userInfo().username;
  return (
    targetUser !== effectiveUser ||
    !ownership.ownerMatches ||
    !ownership.writable
  );
}
