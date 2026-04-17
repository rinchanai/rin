#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";

import {
  runFinalizeInstallPlanInChild,
  type FinalizeInstallOptions,
} from "./apply-plan.js";
import {
  appConfigDirForUser,
  ensureDir,
  publishInstalledRuntime,
  pruneInstalledReleases,
  readInstallerJson,
  readJsonFile,
  runPrivileged,
  syncInstalledDocs,
  writeJsonFile,
  writeJsonFileWithPrivilege,
  writeLaunchersForUser,
} from "./fs-utils.js";
import {
  buildFinalRequirements,
  buildInstallPlanText,
  buildInstallSafetyBoundaryText,
  buildPostInstallInitExitText,
  describeInstallDirState,
  promptChatSetup,
  promptProviderSetup,
  promptTargetInstall,
} from "./interactive.js";
import {
  normalizeInstalledChatSettings,
  persistInstallerOutputs,
  reconcileInstallerManifest,
} from "./persist.js";
import {
  collectDaemonFailureDetails,
  daemonSocketPathForUser,
  installDaemonService,
  reconcileSystemdUserService,
  refreshManagedServiceFiles,
  waitForSocket,
} from "./service.js";
import { releaseInfoFromEnv } from "../rin-lib/release.js";
import { startUpdater } from "./updater.js";

function runCommand(command: string, args: string[], options: any = {}) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`terminated:${signal}`));
      resolve(code ?? 0);
    });
  });
}

function listSystemUsers() {
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

function ensureNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Installer cancelled.");
    process.exit(1);
  }
  return value as T;
}

export function detectCurrentUser() {
  const candidates = [
    process.env.SUDO_USER,
    process.env.LOGNAME,
    process.env.USER,
    (() => {
      try {
        return os.userInfo().username;
      } catch {
        return "";
      }
    })(),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return candidates[0] || "unknown";
}

function findSystemUser(targetUser: string) {
  return listSystemUsers().find((entry) => entry.name === targetUser);
}

function homeForUser(targetUser: string) {
  const matched = findSystemUser(targetUser);
  return (
    matched?.home ||
    path.join(process.platform === "darwin" ? "/Users" : "/home", targetUser)
  );
}

function targetHomeForUser(targetUser: string) {
  return homeForUser(targetUser);
}

function summarizeDirState(dir: string) {
  try {
    const entries = fs.readdirSync(dir);
    return {
      exists: true,
      entryCount: entries.length,
      sample: entries.slice(0, 8),
    };
  } catch {
    return { exists: false, entryCount: 0, sample: [] as string[] };
  }
}

function repoRootFromHere() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
}

function describeOwnership(targetUser: string, installDir: string) {
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

function shouldUseElevatedWrite(
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

async function applyInstalledRuntime(
  options: FinalizeInstallOptions & {
    persistInstallerState?: boolean;
    daemonFailureCode: string;
  },
) {
  const currentUser =
    String(options.currentUser || "").trim() || detectCurrentUser();
  const targetUser = String(options.targetUser || "").trim() || currentUser;
  const installDir =
    String(options.installDir || "").trim() ||
    path.join(targetHomeForUser(targetUser), ".rin");
  const provider = String(options.provider || "");
  const modelId = String(options.modelId || "");
  const thinkingLevel = String(options.thinkingLevel || "");
  const chatConfig = options.chatConfig || null;
  const authData = options.authData || {};
  const sourceRoot =
    String(options.sourceRoot || "").trim() || repoRootFromHere();
  const release = options.release || releaseInfoFromEnv();
  const persistInstallerState = Boolean(options.persistInstallerState);

  const ownership = describeOwnership(targetUser, installDir);
  const installServiceNow =
    process.platform === "darwin" || process.platform === "linux";
  const useElevatedWrite = shouldUseElevatedWrite(targetUser, ownership);
  const useElevatedService = installServiceNow && targetUser !== currentUser;
  const serviceDeps = { findSystemUser, targetHomeForUser, repoRootFromHere };

  const publishedRuntime = publishInstalledRuntime(
    sourceRoot,
    installDir,
    targetUser,
    useElevatedWrite,
    { findSystemUser },
  );
  const installedDocs = syncInstalledDocs(
    sourceRoot,
    installDir,
    targetUser,
    useElevatedWrite,
    { findSystemUser },
  );
  const prunedReleases = pruneInstalledReleases(
    installDir,
    3,
    publishedRuntime.releaseRoot,
    useElevatedWrite,
  );
  const installerManifest = reconcileInstallerManifest(
    {
      targetUser,
      installDir,
      provider,
      modelId,
      thinkingLevel,
      chatConfig,
      release,
      elevated: useElevatedWrite,
    },
    {
      findSystemUser,
      ensureDir,
      readInstallerJson,
      writeJsonFileWithPrivilege,
      writeJsonFile,
      runPrivileged,
    },
  );
  refreshManagedServiceFiles(
    targetUser,
    installDir,
    useElevatedWrite,
    serviceDeps,
  );
  reconcileSystemdUserService(
    targetUser,
    installDir,
    "restart",
    useElevatedWrite,
    { findSystemUser },
  );

  const written = persistInstallerState
    ? await persistInstallerOutputs(
        {
          currentUser,
          targetUser,
          installDir,
          provider,
          modelId,
          thinkingLevel,
          chatConfig,
          authData,
          release,
          elevated: useElevatedWrite,
        },
        {
          findSystemUser,
          ensureDir,
          readInstallerJson,
          writeJsonFileWithPrivilege,
          writeJsonFile,
          appConfigDirForUser: (user) => appConfigDirForUser(user, homeForUser),
          readJsonFile,
          writeLaunchersForUser: (user, dir) =>
            writeLaunchersForUser(user, dir, homeForUser),
          reconcileInstallerManifest,
          runPrivileged,
        },
      )
    : normalizeInstalledChatSettings(
        {
          targetUser,
          installDir,
          elevated: useElevatedWrite,
        },
        {
          findSystemUser,
          readInstallerJson,
          writeJsonFileWithPrivilege,
          writeJsonFile,
        },
      );

  let installedService: null | {
    kind: "launchd" | "systemd";
    label: string;
    servicePath: string;
    stdoutPath?: string;
    stderrPath?: string;
    service?: string;
  } = null;
  if (installServiceNow) {
    try {
      installedService = installDaemonService(
        targetUser,
        installDir,
        useElevatedService,
        serviceDeps,
      );
    } catch (error) {
      if (persistInstallerState) throw error;
      installedService = null;
    }
  }

  const daemonReady = installedService
    ? await waitForSocket(
        daemonSocketPathForUser(targetUser, serviceDeps),
        5000,
        targetUser,
      )
    : false;
  if (!daemonReady && installServiceNow && installedService) {
    throw new Error(
      `${options.daemonFailureCode}\n${collectDaemonFailureDetails(targetUser, installDir, { findSystemUser, targetHomeForUser })}`,
    );
  }

  return {
    currentUser,
    targetUser,
    installDir,
    written,
    installerManifest,
    publishedRuntime,
    installedDocs,
    installedDocsDir: installedDocs.rin,
    prunedReleases,
    installedService,
    daemonReady,
    ownership,
    serviceHint:
      process.platform === "darwin"
        ? installServiceNow
          ? "A macOS launchd LaunchAgent will be installed and started for this daemon."
          : "You skipped launchd installation for now; start the daemon explicitly when needed."
        : process.platform === "linux"
          ? installServiceNow
            ? "A Linux user service will be installed and started for this daemon when supported."
            : "You skipped dedicated Linux service installation for now; start the daemon explicitly when needed."
          : "No dedicated service was installed; the installer will not start the daemon for you.",
  };
}

export async function finalizeCoreUpdate(options: {
  currentUser: string;
  targetUser: string;
  installDir: string;
  sourceRoot?: string;
  release?: {
    channel: "stable" | "beta" | "git";
    version?: string;
    branch?: string;
    ref?: string;
    sourceLabel?: string;
    archiveUrl?: string;
    installedAt?: string;
  };
}) {
  const result = await applyInstalledRuntime({
    ...options,
    persistInstallerState: false,
    daemonFailureCode: "rin_core_update_daemon_not_ready",
  });
  return { ...result, mode: "core-only" as const };
}

export async function finalizeInstallPlan(options: FinalizeInstallOptions) {
  return await applyInstalledRuntime({
    ...options,
    persistInstallerState: true,
    daemonFailureCode: "rin_installer_daemon_not_ready",
  });
}

async function launchInstallerInitTui(options: {
  rinPath: string;
  sourceRoot: string;
}) {
  return await runCommand(options.rinPath, [], {
    env: {
      ...process.env,
      RIN_INSTALL_AUTO_INIT: "1",
    },
    cwd: options.sourceRoot,
  });
}

export async function startInstaller() {
  const applyPlanRaw = String(process.env.RIN_INSTALL_APPLY_PLAN || "").trim();
  if (applyPlanRaw) {
    const resultPath = String(
      process.env.RIN_INSTALL_APPLY_RESULT || "",
    ).trim();
    const errorPath = String(process.env.RIN_INSTALL_APPLY_ERROR || "").trim();
    try {
      const result = await finalizeInstallPlan(
        JSON.parse(applyPlanRaw) as FinalizeInstallOptions,
      );
      if (resultPath)
        fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");
      return;
    } catch (error: any) {
      if (errorPath)
        fs.writeFileSync(
          errorPath,
          String(error?.message || error || "rin_installer_apply_failed"),
          "utf8",
        );
      throw error;
    }
  }

  if (
    String(process.env.RIN_INSTALL_MODE || "")
      .trim()
      .toLowerCase() === "update"
  ) {
    await startUpdater({
      detectCurrentUser,
      repoRootFromHere,
      ensureNotCancelled,
      release: releaseInfoFromEnv(),
    });
    return;
  }

  const currentUser = detectCurrentUser();
  const allUsers = listSystemUsers();
  intro("Rin Installer");
  note(buildInstallSafetyBoundaryText(), "Safety boundary");

  const promptApi = { ensureNotCancelled, select, text, confirm };
  const target = await promptTargetInstall(
    promptApi,
    currentUser,
    allUsers,
    targetHomeForUser,
  );
  if (target.cancelled) {
    note(
      [
        "No eligible existing users were found on this system.",
        `Detected current user: ${currentUser}`,
        `Visible users: ${allUsers.map((entry) => entry.name).join(", ") || "none"}`,
      ].join("\n"),
      "Target user",
    );
    outro("Nothing installed.");
    return;
  }

  const { targetUser, installDir } = target;
  const installDirNote = describeInstallDirState(
    installDir,
    summarizeDirState(installDir),
  );
  note(installDirNote.text, installDirNote.title);

  const { provider, modelId, thinkingLevel, authResult } =
    await promptProviderSetup(promptApi, installDir, readJsonFile);
  const { chatDescription, chatDetail, chatConfig } =
    await promptChatSetup(promptApi);

  note(
    buildInstallPlanText({
      currentUser,
      targetUser,
      installDir,
      provider,
      modelId,
      thinkingLevel,
      authAvailable: Boolean(authResult.available),
      chatDescription,
      chatDetail,
    }),
    "Install choices",
  );

  const ownership = describeOwnership(targetUser, installDir);
  if (!ownership.ownerMatches && ownership.targetUid >= 0) {
    note(
      [
        `Target dir owner uid/gid: ${ownership.statUid}:${ownership.statGid}`,
        `Target user uid/gid: ${ownership.targetUid}:${ownership.targetGid}`,
        "This directory is not currently owned by the selected target user.",
        "The installer will still write config if it can, but you may want to fix ownership before switching fully.",
      ].join("\n"),
      "Ownership check",
    );
  }
  if (!ownership.writable)
    note(
      "The selected install directory is not writable by the current installer process.",
      "Ownership check",
    );

  const installServiceNow =
    process.platform === "darwin" || process.platform === "linux";
  const needsElevatedWrite = !ownership.writable;
  const needsElevatedService = installServiceNow && targetUser !== currentUser;
  const finalRequirements = buildFinalRequirements({
    installServiceNow,
    needsElevatedWrite,
    needsElevatedService,
  });
  const shouldProceed = ensureNotCancelled(
    await confirm({
      message: [
        "Finalize installation now?",
        ...finalRequirements.map((item) => `- ${item}`),
      ].join("\n"),
      initialValue: true,
    }),
  );
  if (!shouldProceed) {
    outro("Installer finished without writing changes.");
    return;
  }

  const result = await runFinalizeInstallPlanInChild(
    {
      currentUser,
      targetUser,
      installDir,
      provider,
      modelId,
      thinkingLevel,
      chatDescription,
      chatDetail,
      chatConfig,
      authData: authResult.authData || {},
      release: releaseInfoFromEnv(),
    },
    needsElevatedWrite
      ? "Publishing runtime and writing configuration with elevated permissions..."
      : "Publishing runtime and writing configuration...",
    { ensureNotCancelled },
  );
  const {
    written,
    publishedRuntime,
    installedDocs,
    installedDocsDir,
    installedService,
    daemonReady,
    serviceHint,
  } = result;

  note(
    [
      `Target install dir: ${installDir}`,
      `Written: ${written.settingsPath}`,
      `Written: ${written.authPath}`,
      `Written: ${written.manifestPath}`,
      `Written: ${written.launcherPath}`,
      `Written: ${written.rinPath}`,
      `Written: ${written.rinInstallPath}`,
      `Written: ${publishedRuntime.currentLink}`,
      `Written: ${publishedRuntime.releaseRoot}`,
      installedDocsDir ? `Written: ${installedDocsDir}` : "",
      ...(Array.isArray(installedDocs?.pi)
        ? installedDocs.pi.map((item: string) => `Written: ${item}`)
        : []),
      installedService ? `Written: ${installedService.servicePath}` : "",
      installedService
        ? `${installedService.kind} label: ${installedService.label}`
        : "",
    ].join("\n"),
    "Written paths",
  );

  const userSuffix = currentUser === targetUser ? "" : ` -u ${targetUser}`;
  if (daemonReady) {
    note(
      [
        "Installation is done. Rin will now open an initialization TUI.",
        "You can exit it anytime; the installer will print the next-step reminder afterwards.",
      ].join("\n"),
      "Launching init",
    );
    await launchInstallerInitTui({
      rinPath: written.rinPath,
      sourceRoot: repoRootFromHere(),
    });
    note(
      buildPostInstallInitExitText({ currentUser, targetUser }),
      "After init",
    );
  }

  outro(
    `Installer wrote config for ${targetUser}.${installedService ? ` (${installedService.kind} service installed).` : ""}`,
  );
}

async function main() {
  await startInstaller();
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error) => {
    const message =
      error instanceof Error
        ? error.message
        : String(error || "rin_installer_failed");
    console.error(message);
    process.exit(1);
  });
}
