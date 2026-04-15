import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const installerMain = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "main.js"))
    .href
);

function createFinalizeResult() {
  return {
    written: {
      settingsPath: "/srv/rin/settings.json",
      authPath: "/srv/rin/auth.json",
      manifestPath: "/srv/rin/installer.json",
      launcherPath: "/home/demo/.config/rin/install.json",
      rinPath: "/home/demo/.local/bin/rin",
      rinInstallPath: "/home/demo/.local/bin/rin-install",
    },
    publishedRuntime: {
      currentLink: "/srv/rin/app/current",
      releaseRoot: "/srv/rin/app/releases/2026-04-14T00-00-00-000Z",
    },
    installedDocs: {
      pi: ["/srv/rin/docs/pi/README.md"],
    },
    installedDocsDir: "/srv/rin/docs",
    installedService: {
      servicePath: "/home/demo/.config/systemd/user/rin-daemon.service",
      kind: "systemd",
      label: "rin-daemon-demo.service",
    },
    daemonReady: true,
    serviceHint: "service ready",
  };
}

test("finalizeCoreUpdate and finalizeInstallPlan pass stable mode flags into applyInstalledRuntime", async () => {
  const calls = [];
  const applyInstalledRuntime = async (options) => {
    calls.push(options);
    return { ok: true, written: {} };
  };

  const coreResult = await installerMain.finalizeCoreUpdate(
    {
      currentUser: "builder",
      targetUser: "demo",
      installDir: "/srv/rin",
      sourceRoot: "/repo",
    },
    { applyInstalledRuntime },
  );
  const installResult = await installerMain.finalizeInstallPlan(
    {
      currentUser: "builder",
      targetUser: "demo",
      installDir: "/srv/rin",
      provider: "openai",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
      authData: {},
      koishiDescription: "disabled",
      koishiDetail: "none",
      koishiConfig: null,
    },
    { applyInstalledRuntime },
  );

  assert.equal(calls[0].persistInstallerState, false);
  assert.equal(calls[0].daemonFailureCode, "rin_core_update_daemon_not_ready");
  assert.equal(coreResult.mode, "core-only");

  assert.equal(calls[1].persistInstallerState, true);
  assert.equal(calls[1].daemonFailureCode, "rin_installer_daemon_not_ready");
  assert.equal(installResult.ok, true);
});

test("startInstaller apply-plan mode writes the finalized result and skips interactive prompts", async () => {
  const writes = [];
  const finalizeCalls = [];

  await installerMain.startInstaller({
    env: {
      RIN_INSTALL_APPLY_PLAN: JSON.stringify({
        currentUser: "builder",
        targetUser: "demo",
        installDir: "/srv/rin",
      }),
      RIN_INSTALL_APPLY_RESULT: "/tmp/result.jsonl",
    },
    writeFileSync: (filePath, content, encoding) => {
      writes.push([filePath, content, encoding]);
    },
    finalizeInstallPlan: async (options) => {
      finalizeCalls.push(options);
      return { status: "ok", installDir: options.installDir };
    },
    intro: () => {
      throw new Error("should_not_prompt_intro");
    },
  });

  assert.deepEqual(finalizeCalls, [
    { currentUser: "builder", targetUser: "demo", installDir: "/srv/rin" },
  ]);
  assert.deepEqual(writes, [
    ["/tmp/result.jsonl", '{"status":"ok","installDir":"/srv/rin"}\n', "utf8"],
  ]);
});

test("startInstaller apply-plan mode writes an error file and rethrows failures", async () => {
  const writes = [];

  await assert.rejects(
    installerMain.startInstaller({
      env: {
        RIN_INSTALL_APPLY_PLAN: JSON.stringify({ installDir: "/srv/rin" }),
        RIN_INSTALL_APPLY_ERROR: "/tmp/error.txt",
      },
      writeFileSync: (filePath, content, encoding) => {
        writes.push([filePath, content, encoding]);
      },
      finalizeInstallPlan: async () => {
        throw new Error("boom");
      },
    }),
    /boom/,
  );

  assert.deepEqual(writes, [["/tmp/error.txt", "boom", "utf8"]]);
});

test("startInstaller update mode delegates to the updater with stable helpers", async () => {
  const updaterCalls = [];
  const ensureNotCancelled = (value) => value;

  await installerMain.startInstaller({
    env: { RIN_INSTALL_MODE: "update" },
    startUpdater: async (deps) => {
      updaterCalls.push(deps);
    },
    detectCurrentUser: () => "builder",
    repoRootFromHere: () => "/repo",
    ensureNotCancelled,
    intro: () => {
      throw new Error("should_not_enter_interactive_mode");
    },
  });

  assert.equal(updaterCalls.length, 1);
  assert.equal(updaterCalls[0].detectCurrentUser(), "builder");
  assert.equal(updaterCalls[0].repoRootFromHere(), "/repo");
  assert.equal(updaterCalls[0].ensureNotCancelled, ensureNotCancelled);
});

test("startInstaller exits cleanly when no eligible install target is available", async () => {
  const notes = [];
  const outros = [];

  await installerMain.startInstaller({
    detectCurrentUser: () => "builder",
    listSystemUsers: () => [{ name: "builder" }, { name: "demo" }],
    intro: () => {},
    note: (text, title) => notes.push([title, text]),
    outro: (text) => outros.push(text),
    promptTargetInstall: async () => ({ cancelled: true }),
  });

  assert.equal(notes[0][0], "Safety boundary");
  assert.equal(notes[1][0], "Target user");
  assert.match(notes[1][1], /No eligible existing users were found/);
  assert.match(notes[1][1], /Detected current user: builder/);
  assert.match(notes[1][1], /Visible users: builder, demo/);
  assert.deepEqual(outros, ["Nothing installed."]);
});

test("startInstaller stops before finalization when the operator declines the final confirmation", async () => {
  const notes = [];
  const outros = [];
  let finalized = 0;

  await installerMain.startInstaller({
    detectCurrentUser: () => "builder",
    listSystemUsers: () => [{ name: "builder" }],
    intro: () => {},
    note: (text, title) => notes.push([title, text]),
    outro: (text) => outros.push(text),
    ensureNotCancelled: (value) => value,
    promptTargetInstall: async () => ({
      cancelled: false,
      targetUser: "builder",
      installDir: "/srv/rin",
    }),
    describeInstallDirState: () => ({
      title: "Install dir",
      text: "empty dir",
    }),
    summarizeDirState: () => ({ exists: false, entryCount: 0, sample: [] }),
    promptProviderSetup: async () => ({
      provider: "openai",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
      authResult: { available: true, authData: { apiKey: "x" } },
    }),
    promptKoishiSetup: async () => ({
      koishiDescription: "disabled",
      koishiDetail: "none",
      koishiConfig: null,
    }),
    buildInstallPlanText: () => "install plan",
    describeOwnership: () => ({
      ownerMatches: true,
      writable: true,
      statUid: 1000,
      statGid: 1000,
      targetUid: 1000,
      targetGid: 1000,
    }),
    buildFinalRequirements: () => ["write config"],
    confirm: async () => false,
    runFinalizeInstallPlanInChild: async () => {
      finalized += 1;
      return createFinalizeResult();
    },
  });

  assert.equal(finalized, 0);
  assert.equal(notes[1][0], "Install dir");
  assert.equal(notes[2][0], "Install choices");
  assert.deepEqual(outros, ["Installer finished without writing changes."]);
});

test("startInstaller predicts elevated writes from cross-user ownership and records written paths", async () => {
  const notes = [];
  const outros = [];
  const finalizeCalls = [];
  const initCalls = [];

  await installerMain.startInstaller({
    detectCurrentUser: () => "builder",
    repoRootFromHere: () => "/repo",
    listSystemUsers: () => [{ name: "builder" }, { name: "demo" }],
    intro: () => {},
    note: (text, title) => notes.push([title, text]),
    outro: (text) => outros.push(text),
    ensureNotCancelled: (value) => value,
    promptTargetInstall: async () => ({
      cancelled: false,
      targetUser: "demo",
      installDir: "/srv/rin",
    }),
    describeInstallDirState: () => ({
      title: "Install dir",
      text: "existing dir",
    }),
    summarizeDirState: () => ({
      exists: true,
      entryCount: 3,
      sample: ["app", "docs"],
    }),
    promptProviderSetup: async () => ({
      provider: "openai",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
      authResult: { available: true, authData: { apiKey: "x" } },
    }),
    promptKoishiSetup: async () => ({
      koishiDescription: "onebot enabled",
      koishiDetail: "onebot",
      koishiConfig: { platform: "onebot" },
    }),
    buildInstallPlanText: (options) => `plan for ${options.targetUser}`,
    describeOwnership: () => ({
      ownerMatches: false,
      writable: false,
      statUid: 0,
      statGid: 0,
      targetUid: 1001,
      targetGid: 1001,
    }),
    buildFinalRequirements: (options) => {
      assert.deepEqual(options, {
        installServiceNow:
          process.platform === "darwin" || process.platform === "linux",
        needsElevatedWrite: true,
        needsElevatedService:
          process.platform === "darwin" || process.platform === "linux",
      });
      return ["sudo write", "sudo service"];
    },
    confirm: async () => true,
    runFinalizeInstallPlanInChild: async (options, message, helperDeps) => {
      finalizeCalls.push([options, message, helperDeps]);
      return createFinalizeResult();
    },
    launchInstallerInitTui: async (options) => {
      initCalls.push(options);
      return 0;
    },
  });

  assert.equal(finalizeCalls.length, 1);
  assert.equal(
    finalizeCalls[0][1],
    "Publishing runtime, refreshing launchers, and reconciling managed services with elevated permissions...",
  );
  assert.equal(finalizeCalls[0][0].targetUser, "demo");
  assert.deepEqual(initCalls, [
    { rinPath: "/home/demo/.local/bin/rin", sourceRoot: "/repo" },
  ]);

  const noteTitles = notes.map(([title]) => title);
  assert.deepEqual(noteTitles, [
    "Safety boundary",
    "Install dir",
    "Install choices",
    "Ownership check",
    "Ownership check",
    "Written paths",
    "Launching init",
    "After init",
  ]);
  assert.match(notes[5][1], /Written: \/srv\/rin\/settings.json/);
  assert.match(notes[5][1], /systemd label: rin-daemon-demo.service/);
  assert.match(notes[7][1], /Initialization TUI exited\./);
  assert.match(notes[7][1], /rin doctor -u demo/);
  assert.deepEqual(outros, [
    "Installer wrote config for demo. (systemd service installed).",
  ]);
});

test("startInstaller surfaces cross-user service elevation even when the install dir is writable", async () => {
  const finalizeCalls = [];

  await installerMain.startInstaller({
    detectCurrentUser: () => "builder",
    repoRootFromHere: () => "/repo",
    listSystemUsers: () => [{ name: "builder" }, { name: "demo" }],
    intro: () => {},
    note: () => {},
    outro: () => {},
    ensureNotCancelled: (value) => value,
    promptTargetInstall: async () => ({
      cancelled: false,
      targetUser: "demo",
      installDir: "/srv/rin",
    }),
    describeInstallDirState: () => ({
      title: "Install dir",
      text: "existing dir",
    }),
    summarizeDirState: () => ({
      exists: true,
      entryCount: 1,
      sample: ["app"],
    }),
    promptProviderSetup: async () => ({
      provider: "",
      modelId: "",
      thinkingLevel: "",
      authResult: { available: false, authData: {} },
    }),
    promptKoishiSetup: async () => ({
      koishiDescription: "disabled",
      koishiDetail: "",
      koishiConfig: null,
    }),
    buildInstallPlanText: () => "plan",
    describeOwnership: () => ({
      ownerMatches: true,
      writable: true,
      statUid: 1001,
      statGid: 1001,
      targetUid: 1001,
      targetGid: 1001,
    }),
    buildFinalRequirements: (options) => {
      assert.deepEqual(options, {
        installServiceNow:
          process.platform === "darwin" || process.platform === "linux",
        needsElevatedWrite: true,
        needsElevatedService:
          process.platform === "darwin" || process.platform === "linux",
      });
      return ["sudo write", "sudo service"];
    },
    confirm: async () => true,
    runFinalizeInstallPlanInChild: async (options, message) => {
      finalizeCalls.push([options, message]);
      return createFinalizeResult();
    },
    launchInstallerInitTui: async () => 0,
  });

  assert.equal(finalizeCalls.length, 1);
  assert.equal(
    finalizeCalls[0][1],
    "Publishing runtime, refreshing launchers, and reconciling managed services with elevated permissions...",
  );
});
