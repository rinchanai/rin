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
  promptKoishiSetup,
  promptProviderSetup,
  promptTargetInstall,
} from "./interactive.js";
import {
  reconcileInstallerManifest,
  persistInstallerOutputs,
} from "./persist.js";
import {
  collectDaemonFailureDetails,
  daemonSocketPathForUser,
  installDaemonService,
  waitForSocket,
} from "./service.js";
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

export async function applyInstalledRuntime(
  options: FinalizeInstallOptions & {
    persistInstallerState?: boolean;
    daemonFailureCode: string;
  },
  deps: {
    detectCurrentUser?: typeof detectCurrentUser;
    targetHomeForUser?: typeof targetHomeForUser;
    repoRootFromHere?: typeof repoRootFromHere;
    describeOwnership?: typeof describeOwnership;
    shouldUseElevatedWrite?: typeof shouldUseElevatedWrite;
    findSystemUser?: typeof findSystemUser;
    ensureDir?: typeof ensureDir;
    readInstallerJson?: typeof readInstallerJson;
    writeJsonFileWithPrivilege?: typeof writeJsonFileWithPrivilege;
    writeJsonFile?: typeof writeJsonFile;
    runPrivileged?: typeof runPrivileged;
    appConfigDirForUser?: typeof appConfigDirForUser;
    readJsonFile?: typeof readJsonFile;
    writeLaunchersForUser?: typeof writeLaunchersForUser;
    publishInstalledRuntime?: typeof publishInstalledRuntime;
    syncInstalledDocs?: typeof syncInstalledDocs;
    pruneInstalledReleases?: typeof pruneInstalledReleases;
    reconcileInstallerManifest?: typeof reconcileInstallerManifest;
    persistInstallerOutputs?: typeof persistInstallerOutputs;
    installDaemonService?: typeof installDaemonService;
    daemonSocketPathForUser?: typeof daemonSocketPathForUser;
    waitForSocket?: typeof waitForSocket;
    collectDaemonFailureDetails?: typeof collectDaemonFailureDetails;
  } = {},
) {
  const detectCurrentUserImpl = deps.detectCurrentUser ?? detectCurrentUser;
  const targetHomeForUserImpl = deps.targetHomeForUser ?? targetHomeForUser;
  const repoRootFromHereImpl = deps.repoRootFromHere ?? repoRootFromHere;
  const describeOwnershipImpl = deps.describeOwnership ?? describeOwnership;
  const shouldUseElevatedWriteImpl =
    deps.shouldUseElevatedWrite ?? shouldUseElevatedWrite;
  const findSystemUserImpl = deps.findSystemUser ?? findSystemUser;
  const ensureDirImpl = deps.ensureDir ?? ensureDir;
  const readInstallerJsonImpl = deps.readInstallerJson ?? readInstallerJson;
  const writeJsonFileWithPrivilegeImpl =
    deps.writeJsonFileWithPrivilege ?? writeJsonFileWithPrivilege;
  const writeJsonFileImpl = deps.writeJsonFile ?? writeJsonFile;
  const runPrivilegedImpl = deps.runPrivileged ?? runPrivileged;
  const appConfigDirForUserImpl =
    deps.appConfigDirForUser ?? appConfigDirForUser;
  const readJsonFileImpl = deps.readJsonFile ?? readJsonFile;
  const writeLaunchersForUserImpl =
    deps.writeLaunchersForUser ?? writeLaunchersForUser;
  const publishInstalledRuntimeImpl =
    deps.publishInstalledRuntime ?? publishInstalledRuntime;
  const syncInstalledDocsImpl = deps.syncInstalledDocs ?? syncInstalledDocs;
  const pruneInstalledReleasesImpl =
    deps.pruneInstalledReleases ?? pruneInstalledReleases;
  const reconcileInstallerManifestImpl =
    deps.reconcileInstallerManifest ?? reconcileInstallerManifest;
  const persistInstallerOutputsImpl =
    deps.persistInstallerOutputs ?? persistInstallerOutputs;
  const installDaemonServiceImpl =
    deps.installDaemonService ?? installDaemonService;
  const daemonSocketPathForUserImpl =
    deps.daemonSocketPathForUser ?? daemonSocketPathForUser;
  const waitForSocketImpl = deps.waitForSocket ?? waitForSocket;
  const collectDaemonFailureDetailsImpl =
    deps.collectDaemonFailureDetails ?? collectDaemonFailureDetails;

  const currentUser =
    String(options.currentUser || "").trim() || detectCurrentUserImpl();
  const targetUser = String(options.targetUser || "").trim() || currentUser;
  const installDir =
    String(options.installDir || "").trim() ||
    path.join(targetHomeForUserImpl(targetUser), ".rin");
  const provider = String(options.provider || "");
  const modelId = String(options.modelId || "");
  const thinkingLevel = String(options.thinkingLevel || "");
  const koishiConfig = options.koishiConfig || null;
  const authData = options.authData || {};
  const sourceRoot =
    String(options.sourceRoot || "").trim() || repoRootFromHereImpl();
  const persistInstallerState = Boolean(options.persistInstallerState);

  const ownership = describeOwnershipImpl(targetUser, installDir);
  const installServiceNow =
    process.platform === "darwin" || process.platform === "linux";
  const useElevatedWrite = shouldUseElevatedWriteImpl(targetUser, ownership);
  const useElevatedService = installServiceNow && targetUser !== currentUser;
  const serviceDeps = {
    findSystemUser: findSystemUserImpl,
    targetHomeForUser: targetHomeForUserImpl,
    repoRootFromHere: repoRootFromHereImpl,
  };

  const publishedRuntime = publishInstalledRuntimeImpl(
    sourceRoot,
    installDir,
    targetUser,
    useElevatedWrite,
    { findSystemUser: findSystemUserImpl },
  );
  const installedDocs = syncInstalledDocsImpl(
    sourceRoot,
    installDir,
    targetUser,
    useElevatedWrite,
    { findSystemUser: findSystemUserImpl },
  );
  const prunedReleases = pruneInstalledReleasesImpl(
    installDir,
    3,
    publishedRuntime.releaseRoot,
    useElevatedWrite,
  );
  const installerManifest = reconcileInstallerManifestImpl(
    {
      targetUser,
      installDir,
      provider,
      modelId,
      thinkingLevel,
      koishiConfig,
      elevated: useElevatedWrite,
    },
    {
      findSystemUser: findSystemUserImpl,
      ensureDir: ensureDirImpl,
      readInstallerJson: readInstallerJsonImpl,
      writeJsonFileWithPrivilege: writeJsonFileWithPrivilegeImpl,
      writeJsonFile: writeJsonFileImpl,
      runPrivileged: runPrivilegedImpl,
    },
  );

  const written = persistInstallerState
    ? await persistInstallerOutputsImpl(
        {
          currentUser,
          targetUser,
          installDir,
          provider,
          modelId,
          thinkingLevel,
          koishiConfig,
          authData,
          elevated: useElevatedWrite,
        },
        {
          findSystemUser: findSystemUserImpl,
          ensureDir: ensureDirImpl,
          readInstallerJson: readInstallerJsonImpl,
          writeJsonFileWithPrivilege: writeJsonFileWithPrivilegeImpl,
          writeJsonFile: writeJsonFileImpl,
          appConfigDirForUser: (user) =>
            appConfigDirForUserImpl(user, homeForUser),
          readJsonFile: readJsonFileImpl,
          writeLaunchersForUser: (user, dir) =>
            writeLaunchersForUserImpl(user, dir, homeForUser),
          reconcileInstallerManifest: reconcileInstallerManifestImpl,
          runPrivileged: runPrivilegedImpl,
        },
      )
    : undefined;

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
      installedService = installDaemonServiceImpl(
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
    ? await waitForSocketImpl(
        daemonSocketPathForUserImpl(targetUser, serviceDeps),
        5000,
        targetUser,
      )
    : false;
  if (!daemonReady && installServiceNow && installedService) {
    throw new Error(
      `${options.daemonFailureCode}\n${collectDaemonFailureDetailsImpl(targetUser, installDir, { findSystemUser: findSystemUserImpl, targetHomeForUser: targetHomeForUserImpl })}`,
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

export async function finalizeCoreUpdate(
  options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    sourceRoot?: string;
  },
  deps: {
    applyInstalledRuntime?: typeof applyInstalledRuntime;
  } = {},
) {
  const applyRuntime = deps.applyInstalledRuntime ?? applyInstalledRuntime;
  const result = await applyRuntime({
    ...options,
    persistInstallerState: false,
    daemonFailureCode: "rin_core_update_daemon_not_ready",
  });
  return { ...result, mode: "core-only" as const };
}

export async function finalizeInstallPlan(
  options: FinalizeInstallOptions,
  deps: {
    applyInstalledRuntime?: typeof applyInstalledRuntime;
  } = {},
) {
  const applyRuntime = deps.applyInstalledRuntime ?? applyInstalledRuntime;
  return await applyRuntime({
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

export async function startInstaller(
  deps: {
    env?: NodeJS.ProcessEnv;
    writeFileSync?: typeof fs.writeFileSync;
    finalizeInstallPlan?: typeof finalizeInstallPlan;
    startUpdater?: typeof startUpdater;
    detectCurrentUser?: typeof detectCurrentUser;
    repoRootFromHere?: typeof repoRootFromHere;
    ensureNotCancelled?: typeof ensureNotCancelled;
    listSystemUsers?: typeof listSystemUsers;
    intro?: typeof intro;
    note?: typeof note;
    outro?: typeof outro;
    select?: typeof select;
    text?: typeof text;
    confirm?: typeof confirm;
    promptTargetInstall?: typeof promptTargetInstall;
    targetHomeForUser?: typeof targetHomeForUser;
    describeInstallDirState?: typeof describeInstallDirState;
    summarizeDirState?: typeof summarizeDirState;
    promptProviderSetup?: typeof promptProviderSetup;
    readJsonFile?: typeof readJsonFile;
    promptKoishiSetup?: typeof promptKoishiSetup;
    buildInstallPlanText?: typeof buildInstallPlanText;
    describeOwnership?: typeof describeOwnership;
    buildFinalRequirements?: typeof buildFinalRequirements;
    runFinalizeInstallPlanInChild?: typeof runFinalizeInstallPlanInChild;
    launchInstallerInitTui?: typeof launchInstallerInitTui;
  } = {},
) {
  const env = deps.env ?? process.env;
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync;
  const finalizeInstallPlanFn = deps.finalizeInstallPlan ?? finalizeInstallPlan;
  const startUpdaterFn = deps.startUpdater ?? startUpdater;
  const detectCurrentUserFn = deps.detectCurrentUser ?? detectCurrentUser;
  const repoRootFromHereFn = deps.repoRootFromHere ?? repoRootFromHere;
  const ensureNotCancelledFn = deps.ensureNotCancelled ?? ensureNotCancelled;
  const listSystemUsersFn = deps.listSystemUsers ?? listSystemUsers;
  const introFn = deps.intro ?? intro;
  const noteFn = deps.note ?? note;
  const outroFn = deps.outro ?? outro;
  const selectFn = deps.select ?? select;
  const textFn = deps.text ?? text;
  const confirmFn = deps.confirm ?? confirm;
  const promptTargetInstallFn = deps.promptTargetInstall ?? promptTargetInstall;
  const targetHomeForUserFn = deps.targetHomeForUser ?? targetHomeForUser;
  const describeInstallDirStateFn =
    deps.describeInstallDirState ?? describeInstallDirState;
  const summarizeDirStateFn = deps.summarizeDirState ?? summarizeDirState;
  const promptProviderSetupFn = deps.promptProviderSetup ?? promptProviderSetup;
  const readJsonFileFn = deps.readJsonFile ?? readJsonFile;
  const promptKoishiSetupFn = deps.promptKoishiSetup ?? promptKoishiSetup;
  const buildInstallPlanTextFn =
    deps.buildInstallPlanText ?? buildInstallPlanText;
  const describeOwnershipFn = deps.describeOwnership ?? describeOwnership;
  const buildFinalRequirementsFn =
    deps.buildFinalRequirements ?? buildFinalRequirements;
  const runFinalizeInstallPlanInChildFn =
    deps.runFinalizeInstallPlanInChild ?? runFinalizeInstallPlanInChild;
  const launchInstallerInitTuiFn =
    deps.launchInstallerInitTui ?? launchInstallerInitTui;

  const applyPlanRaw = String(env.RIN_INSTALL_APPLY_PLAN || "").trim();
  if (applyPlanRaw) {
    const resultPath = String(env.RIN_INSTALL_APPLY_RESULT || "").trim();
    const errorPath = String(env.RIN_INSTALL_APPLY_ERROR || "").trim();
    try {
      const result = await finalizeInstallPlanFn(
        JSON.parse(applyPlanRaw) as FinalizeInstallOptions,
      );
      if (resultPath)
        writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");
      return;
    } catch (error: any) {
      if (errorPath)
        writeFileSync(
          errorPath,
          String(error?.message || error || "rin_installer_apply_failed"),
          "utf8",
        );
      throw error;
    }
  }

  if (
    String(env.RIN_INSTALL_MODE || "")
      .trim()
      .toLowerCase() === "update"
  ) {
    await startUpdaterFn({
      detectCurrentUser: detectCurrentUserFn,
      repoRootFromHere: repoRootFromHereFn,
      ensureNotCancelled: ensureNotCancelledFn,
    });
    return;
  }

  const currentUser = detectCurrentUserFn();
  const allUsers = listSystemUsersFn();
  introFn("Rin Installer");
  noteFn(buildInstallSafetyBoundaryText(), "Safety boundary");

  const promptApi = {
    ensureNotCancelled: ensureNotCancelledFn,
    select: selectFn,
    text: textFn,
    confirm: confirmFn,
  };
  const target = await promptTargetInstallFn(
    promptApi,
    currentUser,
    allUsers,
    targetHomeForUserFn,
  );
  if (target.cancelled) {
    noteFn(
      [
        "No eligible existing users were found on this system.",
        `Detected current user: ${currentUser}`,
        `Visible users: ${allUsers.map((entry) => entry.name).join(", ") || "none"}`,
      ].join("\n"),
      "Target user",
    );
    outroFn("Nothing installed.");
    return;
  }

  const { targetUser, installDir } = target;
  const installDirNote = describeInstallDirStateFn(
    installDir,
    summarizeDirStateFn(installDir),
  );
  noteFn(installDirNote.text, installDirNote.title);

  const { provider, modelId, thinkingLevel, authResult } =
    await promptProviderSetupFn(promptApi, installDir, readJsonFileFn);
  const { koishiDescription, koishiDetail, koishiConfig } =
    await promptKoishiSetupFn(promptApi);

  noteFn(
    buildInstallPlanTextFn({
      currentUser,
      targetUser,
      installDir,
      provider,
      modelId,
      thinkingLevel,
      authAvailable: Boolean(authResult.available),
      koishiDescription,
      koishiDetail,
    }),
    "Install choices",
  );

  const ownership = describeOwnershipFn(targetUser, installDir);
  if (!ownership.ownerMatches && ownership.targetUid >= 0) {
    noteFn(
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
    noteFn(
      "The selected install directory is not writable by the current installer process.",
      "Ownership check",
    );

  const installServiceNow =
    process.platform === "darwin" || process.platform === "linux";
  const needsElevatedWrite = shouldUseElevatedWrite(targetUser, ownership);
  const needsElevatedService = installServiceNow && targetUser !== currentUser;
  const needsElevatedAccess = needsElevatedWrite || needsElevatedService;
  const finalRequirements = buildFinalRequirementsFn({
    installServiceNow,
    needsElevatedWrite,
    needsElevatedService,
  });
  const shouldProceed = ensureNotCancelledFn(
    await confirmFn({
      message: [
        "Finalize installation now?",
        ...finalRequirements.map((item) => `- ${item}`),
      ].join("\n"),
      initialValue: true,
    }),
  );
  if (!shouldProceed) {
    outroFn("Installer finished without writing changes.");
    return;
  }

  const result = await runFinalizeInstallPlanInChildFn(
    {
      currentUser,
      targetUser,
      installDir,
      provider,
      modelId,
      thinkingLevel,
      koishiDescription,
      koishiDetail,
      koishiConfig,
      authData: authResult.authData || {},
    },
    needsElevatedAccess
      ? "Publishing runtime, refreshing launchers, and reconciling managed services with elevated permissions..."
      : "Publishing runtime, refreshing launchers, and reconciling managed services...",
    { ensureNotCancelled: ensureNotCancelledFn },
  );
  const {
    written,
    publishedRuntime,
    installedDocs,
    installedDocsDir,
    installedService,
    daemonReady,
  } = result;

  noteFn(
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

  if (daemonReady) {
    noteFn(
      [
        "Installation is done. Rin will now open an initialization TUI.",
        "You can exit it anytime; the installer will print the next-step reminder afterwards.",
      ].join("\n"),
      "Launching init",
    );
    await launchInstallerInitTuiFn({
      rinPath: written.rinPath,
      sourceRoot: repoRootFromHereFn(),
    });
    noteFn(
      buildPostInstallInitExitText({ currentUser, targetUser }),
      "After init",
    );
  }

  outroFn(
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
