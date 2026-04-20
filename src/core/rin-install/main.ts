#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

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
import { readJsonFile } from "./fs-utils.js";
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
import { detectCurrentUser, repoRootFromHere, runCommand } from "./common.js";
import { finalizeInstallPlan } from "./finalize.js";
import { releaseInfoFromEnv } from "../rin-lib/release.js";
import {
  describeOwnership,
  listSystemUsers,
  targetHomeForUser,
} from "./users.js";
import { startUpdater } from "./updater.js";

function ensureNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Installer cancelled.");
    process.exit(1);
  }
  return value as T;
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
      written.locatorManifestPath &&
      written.locatorManifestPath !== written.manifestPath
        ? `Written: ${written.locatorManifestPath}`
        : "",
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
