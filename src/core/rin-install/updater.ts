import { confirm, intro, note, outro, select } from "@clack/prompts";

import {
  discoverInstalledTargets,
  type InstalledTarget,
} from "./update-targets.js";
import {
  runFinalizeInstallPlanInChild,
  type FinalizeInstallOptions,
} from "./apply-plan.js";

type UpdaterUiDeps = {
  intro?: typeof intro;
  note?: typeof note;
  outro?: typeof outro;
  select?: typeof select;
  confirm?: typeof confirm;
  discoverInstalledTargets?: typeof discoverInstalledTargets;
  runFinalizeInstallPlanInChild?: typeof runFinalizeInstallPlanInChild;
};

export async function startUpdater(
  deps: {
    detectCurrentUser: () => string;
    repoRootFromHere: () => string;
    ensureNotCancelled: <T>(value: T | symbol) => T;
  } & UpdaterUiDeps,
) {
  const currentUser = deps.detectCurrentUser();
  const introPrompt = deps.intro ?? intro;
  const notePrompt = deps.note ?? note;
  const outroPrompt = deps.outro ?? outro;
  const selectPrompt = deps.select ?? select;
  const confirmPrompt = deps.confirm ?? confirm;
  const discoverTargets =
    deps.discoverInstalledTargets ?? discoverInstalledTargets;
  const finalizeInstall =
    deps.runFinalizeInstallPlanInChild ?? runFinalizeInstallPlanInChild;

  introPrompt("Rin Updater");

  const targets = discoverTargets();
  if (!targets.length) {
    notePrompt(
      "No installed Rin daemon targets were discovered on this system.",
      "Update targets",
    );
    outroPrompt("Nothing updated.");
    return;
  }

  const target =
    targets.length === 1
      ? targets[0]!
      : await selectTarget(targets, deps.ensureNotCancelled, selectPrompt);

  const overrideInstallDir = String(
    process.env.RIN_UPDATE_INSTALL_DIR || "",
  ).trim();
  const overrideTargetUser = String(
    process.env.RIN_UPDATE_TARGET_USER || "",
  ).trim();
  const installDir = overrideInstallDir || target.installDir;
  const targetUser = overrideTargetUser || target.targetUser;

  notePrompt(
    [
      `Current user: ${currentUser}`,
      `Launcher owner user: ${currentUser}`,
      `Selected daemon user: ${targetUser}`,
      `Install dir: ${installDir}`,
      `Discovered from: ${target.source}`,
      `Owner home: ${target.ownerHome}`,
      target.source === "launcher"
        ? "Discovery note: launcher metadata can point at a target runtime even when service files are absent or the current shell user is different."
        : "",
      overrideTargetUser ? `Target override: ${overrideTargetUser}` : "",
      overrideInstallDir ? `Install dir override: ${overrideInstallDir}` : "",
      "",
      "Updater policy:",
      "- publish a new runtime release into the existing install dir",
      "- prune old runtime releases and keep only the 3 most recent ones",
      "- refresh launchers and launcher metadata for the current user",
      "- refresh managed daemon service files for the selected target user and restart the daemon when applicable",
      "- preserve existing provider/auth/settings unless changed elsewhere",
      "- cross-user updates can still require sudo/doas even when the install dir already exists",
    ]
      .filter(Boolean)
      .join("\n"),
    "Update plan",
  );

  const shouldProceed = deps.ensureNotCancelled(
    await confirmPrompt({
      message: "Publish the latest built runtime to this installed target now?",
      initialValue: true,
    }),
  );
  if (!shouldProceed) {
    outroPrompt("Updater finished without writing changes.");
    return;
  }

  const result = await finalizeInstall(
    {
      currentUser,
      targetUser,
      installDir,
      sourceRoot: deps.repoRootFromHere(),
    } satisfies FinalizeInstallOptions,
    "Publishing runtime and refreshing the installed target...",
    {
      ensureNotCancelled: deps.ensureNotCancelled,
    },
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
  const userSuffix = currentUser === targetUser ? "" : ` -u ${targetUser}`;

  notePrompt(
    [
      `Launcher metadata user: ${currentUser}`,
      `Daemon target user: ${targetUser}`,
      "",
      `Written: ${written.launcherPath}`,
      `Written: ${written.rinPath}`,
      `Written: ${written.rinInstallPath}`,
      `Written: ${publishedRuntime.currentLink}`,
      `Written: ${publishedRuntime.releaseRoot}`,
      installedDocsDir ? `Written: ${installedDocsDir}` : "",
      ...(Array.isArray(installedDocs?.pi)
        ? installedDocs.pi.map((item: string) => `Written: ${item}`)
        : []),
      result.prunedReleases.removed.length
        ? `Removed old releases: ${result.prunedReleases.removed.length}`
        : "Removed old releases: 0",
      installedService ? `Written: ${installedService.servicePath}` : "",
      installedService
        ? `${installedService.kind} label: ${installedService.label}`
        : "",
      "",
      `Service/platform note: ${serviceHint}`,
      `Daemon started now: ${daemonReady ? "yes" : "no"}`,
      "",
      "Recommended next commands:",
      `- doctor: rin doctor${userSuffix}`,
      `- open Rin: rin${userSuffix}`,
      "- if RPC mode fails, try `rin --std` only as a troubleshooting fallback",
    ]
      .filter(Boolean)
      .join("\n"),
    "Updated target",
  );

  outroPrompt(
    `Updater refreshed ${targetUser} at ${installDir}. ${daemonReady ? `Open with rin${userSuffix}.` : `Use rin start${userSuffix} if you need to start the daemon manually.`}`,
  );
}

async function selectTarget(
  targets: InstalledTarget[],
  ensureNotCancelled: <T>(value: T | symbol) => T,
  selectPrompt: typeof select,
) {
  return targets[
    Number(
      ensureNotCancelled(
        await selectPrompt({
          message: "Choose an installed Rin target to update.",
          options: targets.map((item, index) => ({
            value: index,
            label: `${item.targetUser} → ${item.installDir}`,
            hint: `${item.ownerHome} · ${item.source}`,
          })),
        }),
      ),
    )
  ]!;
}
