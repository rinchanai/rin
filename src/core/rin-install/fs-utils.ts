import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { pickPrivilegeCommand, shellQuote } from "../rin-lib/system.js";
import {
  currentRuntimeRoot,
  installedAppEntryCandidates,
  installedReleaseRoot,
} from "./paths.js";

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function readJsonFileWithPrivilege<T>(filePath: string, fallback: T): T {
  const privilegeCommand = pickPrivilegeCommand();
  try {
    const raw = execFileSync(privilegeCommand, ["cat", filePath], {
      encoding: "utf8",
    });
    return JSON.parse(String(raw || "")) as T;
  } catch {
    return fallback;
  }
}

export function readInstallerJson<T>(
  filePath: string,
  fallback: T,
  elevated = false,
): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error: any) {
    const code = String(error?.code || "");
    if (code === "EACCES" || code === "EPERM") {
      if (!elevated) throw error;
      return readJsonFileWithPrivilege(filePath, fallback);
    }
    return fallback;
  }
}

export function writeJsonFile(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeTextFile(filePath: string, value: string, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, "utf8");
  fs.chmodSync(filePath, mode);
}

export function writeExecutable(filePath: string, content: string) {
  writeTextFile(filePath, content, 0o755);
}

export function launcherScript(candidates: string[]) {
  const checks = candidates
    .map(
      (candidate) =>
        `if [ -f ${shellQuote(candidate)} ]; then exec ${shellQuote(process.execPath)} ${shellQuote(candidate)} "$@"; fi`,
    )
    .join("\n");
  return `#!/usr/bin/env sh\n${checks}\necho "rin: installed runtime entry not found" >&2\nexit 1\n`;
}

export function launcherTargetsForInstallDir(installDir: string) {
  return {
    rin: installedAppEntryCandidates(installDir, "rin"),
    rinInstall: installedAppEntryCandidates(installDir, "rin-install"),
  };
}

export function writeLaunchersForUser(
  userName: string,
  installDir: string,
  homeForUser: (user: string) => string,
) {
  const binDir = path.join(homeForUser(userName), ".local", "bin");
  const targets = launcherTargetsForInstallDir(installDir);
  writeExecutable(path.join(binDir, "rin"), launcherScript(targets.rin));
  writeExecutable(
    path.join(binDir, "rin-install"),
    launcherScript(targets.rinInstall),
  );
  return {
    rinPath: path.join(binDir, "rin"),
    rinInstallPath: path.join(binDir, "rin-install"),
  };
}

export function appConfigDirForUser(
  userName: string,
  homeForUser: (user: string) => string,
) {
  const home = homeForUser(userName);
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "rin");
  return path.join(home, ".config", "rin");
}

export function runPrivileged(command: string, args: string[]) {
  const privilegeCommand = pickPrivilegeCommand();
  execFileSync(privilegeCommand, [command, ...args], { stdio: "inherit" });
}

export function runCommandAsUser(
  targetUser: string,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const envArgs = Object.entries(extraEnv).map(
    ([key, value]) => `${key}=${JSON.stringify(value)}`,
  );
  const shellCommand = [
    ...envArgs,
    JSON.stringify(command),
    ...args.map((arg) => JSON.stringify(arg)),
  ].join(" ");
  const isRoot =
    typeof process.getuid === "function" ? process.getuid() === 0 : false;

  if (isRoot && fs.existsSync("/usr/sbin/runuser")) {
    execFileSync(
      "/usr/sbin/runuser",
      ["-u", targetUser, "--", "sh", "-lc", shellCommand],
      { stdio: "inherit" },
    );
    return;
  }
  const privilegeCommand = pickPrivilegeCommand();
  if (privilegeCommand.endsWith("doas") || privilegeCommand.endsWith("sudo")) {
    execFileSync(
      privilegeCommand,
      ["-u", targetUser, "sh", "-lc", shellCommand],
      { stdio: "inherit" },
    );
    return;
  }
  execFileSync(privilegeCommand, ["sh", "-lc", shellCommand], {
    stdio: "inherit",
  });
}

export function writeTextFileWithPrivilege(
  filePath: string,
  value: string,
  ownerUser?: string,
  ownerGroup?: string | number,
  mode = 0o600,
) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-install-write-"));
  const tempFile = path.join(tempDir, "payload");
  try {
    fs.writeFileSync(tempFile, value, "utf8");
    runPrivileged("mkdir", ["-p", path.dirname(filePath)]);
    runPrivileged("install", [
      "-m",
      String(mode.toString(8)),
      tempFile,
      filePath,
    ]);
    if (ownerUser && process.platform !== "win32") {
      const owner =
        ownerGroup != null && `${ownerGroup}` !== ""
          ? `${ownerUser}:${ownerGroup}`
          : ownerUser;
      runPrivileged("chown", [owner, filePath]);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function writeJsonFileWithPrivilege(
  filePath: string,
  value: unknown,
  ownerUser?: string,
  ownerGroup?: string | number,
) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-install-write-"));
  const tempFile = path.join(tempDir, "payload.json");
  const privilegeCommand = pickPrivilegeCommand();
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    execFileSync(privilegeCommand, ["mkdir", "-p", path.dirname(filePath)], {
      stdio: "inherit",
    });
    execFileSync(
      privilegeCommand,
      ["install", "-m", "600", tempFile, filePath],
      { stdio: "inherit" },
    );
    if (ownerUser && process.platform !== "win32") {
      const owner =
        ownerGroup != null && `${ownerGroup}` !== ""
          ? `${ownerUser}:${ownerGroup}`
          : ownerUser;
      execFileSync(privilegeCommand, ["chown", owner, filePath], {
        stdio: "inherit",
      });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function syncTree(sourcePath: string, destPath: string) {
  execFileSync("rm", ["-rf", destPath], { stdio: "inherit" });
  ensureDir(path.dirname(destPath));
  execFileSync("cp", ["-a", sourcePath, destPath], { stdio: "inherit" });
}

export function syncInstalledDocTree(
  sourceDir: string,
  destDir: string,
  targetUser: string,
  elevated = false,
  deps: { findSystemUser: (user: string) => any },
) {
  if (!fs.existsSync(sourceDir)) return null;
  if (elevated) {
    const target = deps.findSystemUser(targetUser) as any;
    const targetGroup = target?.name ? String(target?.gid ?? "") : "";
    runPrivileged("rm", ["-rf", destDir]);
    runPrivileged("mkdir", ["-p", path.dirname(destDir)]);
    runPrivileged("cp", ["-a", sourceDir, destDir]);
    if (target?.name)
      runPrivileged("chown", [
        "-R",
        `${target.name}${targetGroup ? `:${targetGroup}` : ""}`,
        destDir,
      ]);
    return destDir;
  }
  syncTree(sourceDir, destDir);
  return destDir;
}

export function syncInstalledDocs(
  sourceRoot: string,
  installDir: string,
  targetUser: string,
  elevated = false,
  deps: { findSystemUser: (user: string) => any },
) {
  const installedRinDocsDir = syncInstalledDocTree(
    path.join(sourceRoot, "docs", "rin"),
    path.join(installDir, "docs", "rin"),
    targetUser,
    elevated,
    deps,
  );
  syncInstalledDocTree(
    path.join(sourceRoot, "upstream", "skill-creator"),
    path.join(installDir, "docs", "rin", "builtin-skills", "skill-creator"),
    targetUser,
    elevated,
    deps,
  );
  const piDocRoot = path.join(sourceRoot, "upstream", "pi");
  const piInstallRoot = path.join(installDir, "docs", "pi");
  const installedPiDocs: string[] = [];
  for (const name of [
    "README.md",
    "CHANGELOG.md",
    "docs",
    "examples",
    "_upstream.json",
  ]) {
    const synced = syncInstalledDocTree(
      path.join(piDocRoot, name),
      path.join(piInstallRoot, name),
      targetUser,
      elevated,
      deps,
    );
    if (synced) installedPiDocs.push(synced);
  }
  return { rin: installedRinDocsDir, pi: installedPiDocs };
}

export function releaseIdNow() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

export function publishInstalledRuntime(
  sourceRoot: string,
  installDir: string,
  targetUser: string,
  elevated = false,
  deps: { findSystemUser: (user: string) => any },
) {
  const releaseRoot = installedReleaseRoot(installDir, releaseIdNow());
  const currentLink = currentRuntimeRoot(installDir);
  const currentTmpLink = `${currentLink}.tmp`;
  if (elevated) {
    const target = deps.findSystemUser(targetUser) as any;
    const targetGroup = target?.name ? String(target?.gid ?? "") : "";
    runPrivileged("mkdir", ["-p", releaseRoot]);
    for (const name of ["dist", "node_modules", "package.json"]) {
      runPrivileged("rm", ["-rf", path.join(releaseRoot, name)]);
      runPrivileged("cp", [
        "-a",
        path.join(sourceRoot, name),
        path.join(releaseRoot, name),
      ]);
    }
    try {
      runPrivileged("rm", ["-rf", currentTmpLink]);
    } catch {}
    runPrivileged("ln", ["-s", releaseRoot, currentTmpLink]);
    try {
      runPrivileged("rm", ["-rf", currentLink]);
    } catch {}
    runPrivileged("mv", [currentTmpLink, currentLink]);
    if (target?.name) {
      runPrivileged("chown", [
        "-R",
        `${target.name}${targetGroup ? `:${targetGroup}` : ""}`,
        releaseRoot,
      ]);
      try {
        runPrivileged("chown", [
          "-h",
          `${target.name}${targetGroup ? `:${targetGroup}` : ""}`,
          currentLink,
        ]);
      } catch {}
    }
    return { releaseRoot, currentLink };
  }
  ensureDir(path.dirname(releaseRoot));
  for (const name of ["dist", "node_modules", "package.json"])
    syncTree(path.join(sourceRoot, name), path.join(releaseRoot, name));
  try {
    fs.rmSync(currentTmpLink, { recursive: true, force: true });
  } catch {}
  fs.symlinkSync(releaseRoot, currentTmpLink);
  try {
    fs.rmSync(currentLink, { recursive: true, force: true });
  } catch {}
  fs.renameSync(currentTmpLink, currentLink);
  return { releaseRoot, currentLink };
}

export function listInstalledReleaseNames(
  installDir: string,
  elevated = false,
) {
  const releasesDir = path.join(installDir, "app", "releases");
  if (!elevated) {
    try {
      return fs
        .readdirSync(releasesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [] as string[];
    }
  }
  const privilegeCommand = pickPrivilegeCommand();
  try {
    const raw = execFileSync(
      privilegeCommand,
      [
        process.execPath,
        "-e",
        `const fs=require('node:fs');const dir=process.argv[1];try{const names=fs.readdirSync(dir,{withFileTypes:true}).filter((entry)=>entry.isDirectory()).map((entry)=>entry.name);process.stdout.write(JSON.stringify(names));}catch{process.stdout.write('[]')}`,
        releasesDir,
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [] as string[];
  }
}

export function pruneInstalledReleases(
  installDir: string,
  keepCount: number,
  currentReleaseRoot: string,
  elevated = false,
) {
  const releasesDir = path.join(installDir, "app", "releases");
  const currentReleaseName = path.basename(currentReleaseRoot);
  const names = listInstalledReleaseNames(installDir, elevated).sort((a, b) =>
    b.localeCompare(a),
  );
  const keep = new Set(names.slice(0, Math.max(keepCount, 1)));
  keep.add(currentReleaseName);
  const removed: string[] = [];
  for (const name of names) {
    if (keep.has(name)) continue;
    const releasePath = path.join(releasesDir, name);
    if (elevated) runPrivileged("rm", ["-rf", releasePath]);
    else fs.rmSync(releasePath, { recursive: true, force: true });
    removed.push(releasePath);
  }
  return {
    keepCount: Math.max(keepCount, 1),
    kept: [...keep].sort((a, b) => b.localeCompare(a)),
    removed,
  };
}
