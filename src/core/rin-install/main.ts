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
  buildPlainInstallerSection,
  buildPostInstallInitExitText,
  describeInstallDirState,
  promptChatSetup,
  promptDefaultTargetUser,
  promptProviderSetup,
  promptTargetInstall,
} from "./interactive.js";
import { createInstallerI18n, promptInstallerLanguage } from "./i18n.js";
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
    const i18n = createInstallerI18n(process.env.RIN_INSTALL_LANGUAGE || "en");
    cancel(i18n.installerCancelled);
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

  const selectedLanguage = await promptInstallerLanguage({
    ensureNotCancelled,
    select,
    text,
  });
  process.env.RIN_INSTALL_LANGUAGE = selectedLanguage;
  const i18n = createInstallerI18n(selectedLanguage);

  const currentUser = detectCurrentUser();
  const allUsers = listSystemUsers();
  intro(i18n.introTitle);
  note(buildInstallSafetyBoundaryText(i18n), i18n.safetyBoundaryTitle);

  const promptApi = { ensureNotCancelled, select, text, confirm };
  const target = await promptTargetInstall(
    promptApi,
    currentUser,
    allUsers,
    targetHomeForUser,
    i18n,
  );
  if (target.cancelled) {
    note(
      i18n.noEligibleUsersText(
        currentUser,
        allUsers.map((entry) => entry.name),
      ),
      i18n.targetUserTitle,
    );
    outro(i18n.nothingInstalled);
    return;
  }

  const { targetUser, installDir } = target;
  const installDirNote = describeInstallDirState(
    installDir,
    summarizeDirState(installDir),
    i18n,
  );
  note(installDirNote.text, installDirNote.title);
  const setDefaultTarget = await promptDefaultTargetUser(
    promptApi,
    targetUser,
    i18n,
  );

  const { provider, modelId, thinkingLevel, authResult } =
    await promptProviderSetup(promptApi, installDir, readJsonFile, {}, i18n);
  const { chatDescription, chatDetail, chatConfig } = await promptChatSetup(
    promptApi,
    i18n,
  );

  process.stderr.write(
    `${buildPlainInstallerSection(
      i18n.installChoicesTitle,
      buildInstallPlanText(
        {
          currentUser,
          targetUser,
          installDir,
          provider,
          modelId,
          thinkingLevel,
          authAvailable: Boolean(authResult.available),
          chatDescription,
          chatDetail,
          language: selectedLanguage,
          setDefaultTarget,
        },
        i18n,
      ),
    )}\n\n`,
  );

  const ownership = describeOwnership(targetUser, installDir);
  if (!ownership.ownerMatches && ownership.targetUid >= 0) {
    note(i18n.ownershipMismatchText(ownership), i18n.ownershipCheckTitle);
  }
  if (!ownership.writable) {
    note(i18n.ownershipNotWritableText, i18n.ownershipCheckTitle);
  }

  const installServiceNow =
    process.platform === "darwin" || process.platform === "linux";
  const needsElevatedWrite = !ownership.writable;
  const needsElevatedService = installServiceNow && targetUser !== currentUser;
  const finalRequirements = buildFinalRequirements(
    {
      installServiceNow,
      needsElevatedWrite,
      needsElevatedService,
    },
    i18n,
  );
  const shouldProceed = ensureNotCancelled(
    await confirm({
      message: i18n.finalizeInstallationMessage(finalRequirements),
      initialValue: true,
    }),
  );
  if (!shouldProceed) {
    outro(i18n.installerFinishedWithoutWritingChanges);
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
      language: selectedLanguage,
      setDefaultTarget,
      chatDescription,
      chatDetail,
      chatConfig,
      authData: authResult.authData || {},
      release: releaseInfoFromEnv(),
    },
    needsElevatedWrite
      ? i18n.publishingRuntimeMessageElevated
      : i18n.publishingRuntimeMessage,
    { ensureNotCancelled, i18n },
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
      `${i18n.targetInstallDirLabel}: ${installDir}`,
      `${i18n.writtenPathLabel}: ${written.settingsPath}`,
      `${i18n.writtenPathLabel}: ${written.authPath}`,
      `${i18n.writtenPathLabel}: ${written.manifestPath}`,
      written.locatorManifestPath &&
      written.locatorManifestPath !== written.manifestPath
        ? `${i18n.writtenPathLabel}: ${written.locatorManifestPath}`
        : "",
      `${i18n.writtenPathLabel}: ${written.launcherPath}`,
      `${i18n.writtenPathLabel}: ${written.rinPath}`,
      `${i18n.writtenPathLabel}: ${written.rinInstallPath}`,
      written.targetRinPath && written.targetRinPath !== written.rinPath
        ? `${i18n.writtenPathLabel}: ${written.targetRinPath}`
        : "",
      written.targetRinInstallPath &&
      written.targetRinInstallPath !== written.rinInstallPath
        ? `${i18n.writtenPathLabel}: ${written.targetRinInstallPath}`
        : "",
      `${i18n.writtenPathLabel}: ${publishedRuntime.currentLink}`,
      `${i18n.writtenPathLabel}: ${publishedRuntime.releaseRoot}`,
      installedDocsDir ? `${i18n.writtenPathLabel}: ${installedDocsDir}` : "",
      ...(Array.isArray(installedDocs?.pi)
        ? installedDocs.pi.map(
            (item: string) => `${i18n.writtenPathLabel}: ${item}`,
          )
        : []),
      installedService
        ? `${i18n.writtenPathLabel}: ${installedService.servicePath}`
        : "",
      installedService
        ? `${installedService.kind} ${i18n.serviceLabelLabel}: ${installedService.label}`
        : "",
    ].join("\n"),
    i18n.writtenPathsTitle,
  );

  if (daemonReady) {
    note(i18n.launchingInitText, i18n.launchingInitTitle);
    await launchInstallerInitTui({
      rinPath: written.rinPath,
      sourceRoot: repoRootFromHere(),
    });
    note(
      buildPostInstallInitExitText({ currentUser, targetUser }, i18n),
      i18n.afterInitTitle,
    );
  }

  outro(i18n.outroInstalled(targetUser, installedService?.kind));
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
