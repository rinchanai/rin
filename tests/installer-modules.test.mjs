import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const provider = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "provider-auth.js"),
  ).href
);
const persist = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "persist.js"))
    .href
);
const applyPlan = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "apply-plan.js"),
  ).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-installer-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("provider-auth computes available thinking levels deterministically", () => {
  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: "openai",
      id: "codex-max",
      reasoning: true,
    }),
    ["off", "minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: "anthropic",
      id: "claude",
      reasoning: true,
    }),
    ["off", "minimal", "low", "medium", "high"],
  );
  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: "x",
      id: "y",
      reasoning: false,
    }),
    ["off"],
  );
});

test("provider-auth createInstallerAuthStorage reads install auth.json into AuthStorage", async () => {
  const reads = [];
  const storage = await provider.createInstallerAuthStorage(
    "/srv/rin",
    (filePath, fallback) => {
      reads.push(filePath);
      return filePath.endsWith("auth.json")
        ? { github: { type: "oauth" } }
        : fallback;
    },
    {
      loadRinCodingAgent: async () => ({
        AuthStorage: {
          inMemory(value) {
            return { kind: "storage", value };
          },
        },
      }),
    },
  );
  assert.deepEqual(reads, [path.join("/srv/rin", "auth.json")]);
  assert.deepEqual(storage, {
    kind: "storage",
    value: { github: { type: "oauth" } },
  });
});

test("provider-auth configureProviderAuth reuses existing auth without prompting", async () => {
  let promptCalls = 0;
  const result = await provider.configureProviderAuth("openai", "/srv/rin", {
    readJsonFile: (_filePath, fallback) => fallback,
    ensureNotCancelled: (value) => value,
    createInstallerAuthStorage: async () => ({
      hasAuth: () => true,
      getAll: () => ({ openai: { type: "api_key" } }),
    }),
    text: async () => {
      promptCalls += 1;
      return "unused";
    },
  });
  assert.deepEqual(result, {
    available: true,
    authKind: "existing",
    authData: { openai: { type: "api_key" } },
  });
  assert.equal(promptCalls, 0);
});

test("provider-auth configureProviderAuth supports api-key entry without oauth providers", async () => {
  const prompts = [];
  const store = {
    entries: {},
    hasAuth: () => false,
    getOAuthProviders: () => [],
    set(providerId, value) {
      this.entries[providerId] = value;
    },
    getAll() {
      return this.entries;
    },
  };
  const result = await provider.configureProviderAuth("anthropic", "/srv/rin", {
    readJsonFile: (_filePath, fallback) => fallback,
    ensureNotCancelled: (value) => value,
    createInstallerAuthStorage: async () => store,
    text: async (options) => {
      prompts.push(options.message);
      return "sk-ant";
    },
  });
  assert.deepEqual(prompts, ["Enter the API key or token for anthropic."]);
  assert.deepEqual(result, {
    available: true,
    authKind: "api_key",
    authData: { anthropic: { type: "api_key", key: "sk-ant" } },
  });
});

test("provider-auth configureProviderAuth drives oauth login callbacks and manual code prompts", async () => {
  const spinnerEvents = [];
  const textPrompts = [];
  const timeoutCalls = [];
  const authStore = {
    hasAuth: () => false,
    getOAuthProviders: () => [{ id: "github", name: "GitHub" }],
    async login(providerId, callbacks) {
      assert.equal(providerId, "github");
      callbacks.onAuth({
        url: "https://github.com/login/device",
        instructions: "enter code ABC-123",
      });
      assert.equal(
        await callbacks.onPrompt({ message: "Enter OTP", placeholder: "otp" }),
        "otp-123",
      );
      callbacks.onProgress("Waiting for approval...");
      assert.equal(await callbacks.onManualCodeInput(), "code-from-browser");
      assert.ok(callbacks.signal instanceof AbortSignal);
    },
    getAll: () => ({ github: { type: "oauth" } }),
  };

  const result = await provider.configureProviderAuth("github", "/srv/rin", {
    readJsonFile: (_filePath, fallback) => fallback,
    ensureNotCancelled: (value) => value,
    createInstallerAuthStorage: async () => authStore,
    spinner: () => ({
      start(message) {
        spinnerEvents.push(["start", message]);
      },
      stop(message) {
        spinnerEvents.push(["stop", message]);
      },
      message(message) {
        spinnerEvents.push(["message", message]);
      },
    }),
    text: async (options) => {
      textPrompts.push([options.message, options.placeholder]);
      if (options.message === "Enter OTP") return "otp-123";
      return "code-from-browser";
    },
    timeoutSignal(ms) {
      timeoutCalls.push(ms);
      return new AbortController().signal;
    },
  });

  assert.deepEqual(result, {
    available: true,
    authKind: "oauth",
    authData: { github: { type: "oauth" } },
  });
  assert.deepEqual(timeoutCalls, [10 * 60 * 1000]);
  assert.deepEqual(textPrompts, [
    ["Enter OTP", "otp"],
    [
      "Paste the redirect URL or code from the browser.",
      "paste the final redirect URL or device code",
    ],
  ]);
  assert.deepEqual(spinnerEvents, [
    ["start", "Starting GitHub login..."],
    [
      "stop",
      "Open this URL to continue login:\nhttps://github.com/login/device\nenter code ABC-123",
    ],
    ["message", "Waiting for approval..."],
    ["stop", "GitHub login complete."],
  ]);
});

test("provider-auth configureProviderAuth surfaces oauth failures after stopping the spinner", async () => {
  const spinnerEvents = [];
  await assert.rejects(
    () =>
      provider.configureProviderAuth("github", "/srv/rin", {
        readJsonFile: (_filePath, fallback) => fallback,
        ensureNotCancelled: (value) => value,
        createInstallerAuthStorage: async () => ({
          hasAuth: () => false,
          getOAuthProviders: () => [{ id: "github", name: "GitHub" }],
          async login() {
            throw new Error("oauth_failed");
          },
        }),
        spinner: () => ({
          start(message) {
            spinnerEvents.push(["start", message]);
          },
          stop(message) {
            spinnerEvents.push(["stop", message]);
          },
          message() {},
        }),
        text: async () => "unused",
        timeoutSignal: () => new AbortController().signal,
      }),
    /oauth_failed/,
  );
  assert.deepEqual(spinnerEvents, [
    ["start", "Starting GitHub login..."],
    ["stop", "Login failed for GitHub."],
  ]);
});

test("persist reconcileInstallerManifest writes manifest with expected fields", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const result = persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        koishiConfig: { telegram: { token: "x" } },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );
    assert.ok(result.manifestPath.endsWith(path.join(dir, "installer.json")));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].value.targetUser, "demo");
    assert.equal(writes[0].value.installDir, dir);
    assert.equal(writes[0].value.defaultProvider, "openai");
    assert.equal(writes[0].value.defaultModel, "gpt");
    assert.equal(writes[0].value.defaultThinkingLevel, "medium");
    assert.deepEqual(writes[0].value.koishi, { telegram: { token: "x" } });
  });
});

test("persist reconcileInstallerManifest uses elevated writes and removes legacy manifests", async () => {
  await withTempDir(async (dir) => {
    const privilegedWrites = [];
    const privilegedCommands = [];
    const result = persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir: dir,
        elevated: true,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: async () => {
          throw new Error("ensureDir should not run for elevated writes");
        },
        readInstallerJson: (filePath, fallback) =>
          filePath.endsWith(path.join("config", "installer.json"))
            ? { defaultProvider: "openai" }
            : fallback,
        writeJsonFileWithPrivilege: (filePath, value, ownerUser, ownerGroup) =>
          privilegedWrites.push({ filePath, value, ownerUser, ownerGroup }),
        writeJsonFile: () => {
          throw new Error("plain write should not run for elevated writes");
        },
        runPrivileged: (command, args) =>
          privilegedCommands.push({ command, args }),
      },
    );
    assert.equal(privilegedWrites.length, 1);
    assert.equal(privilegedWrites[0].ownerUser, "demo");
    assert.equal(privilegedWrites[0].ownerGroup, 1000);
    assert.equal(privilegedWrites[0].value.defaultProvider, "openai");
    assert.deepEqual(privilegedCommands, [
      { command: "rm", args: ["-f", result.legacyManifestPath] },
    ]);
  });
});

test("persistInstallerOutputs merges settings auth launcher metadata and launchers coherently", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "builder",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt-5",
        thinkingLevel: "high",
        koishiConfig: {
          telegram: { token: "tg-token" },
          onebot: { endpoint: "http://127.0.0.1:5700" },
        },
        authData: { github: { type: "oauth" } },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: () => {},
        readInstallerJson: (filePath, fallback) => {
          if (filePath.endsWith("settings.json")) {
            return {
              quietStartup: true,
              koishi: { telegram: { token: "old" } },
            };
          }
          if (filePath.endsWith("auth.json")) {
            return { existing: { type: "api_key", key: "secret" } };
          }
          return fallback;
        },
        writeJsonFileWithPrivilege: () => {
          throw new Error("unexpected privileged write");
        },
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        appConfigDirForUser: (userName) => path.join(dir, ".config", userName),
        readJsonFile: (_filePath, fallback) => ({ ...fallback, theme: "dark" }),
        writeLaunchersForUser: (userName, installDir) => ({
          rinPath: path.join(installDir, `launcher-${userName}`),
          rinInstallPath: path.join(installDir, `launcher-install-${userName}`),
        }),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    const settingsWrite = writes.find((entry) =>
      entry.filePath.endsWith("settings.json"),
    );
    const authWrite = writes.find((entry) =>
      entry.filePath.endsWith("auth.json"),
    );
    const launcherWrite = writes.find((entry) =>
      entry.filePath.endsWith(path.join("builder", "install.json")),
    );

    assert.deepEqual(settingsWrite?.value, {
      quietStartup: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "high",
      koishi: {
        telegram: { token: "tg-token" },
        onebot: { endpoint: "http://127.0.0.1:5700" },
      },
    });
    assert.deepEqual(authWrite?.value, {
      existing: { type: "api_key", key: "secret" },
      github: { type: "oauth" },
    });
    assert.equal(launcherWrite?.value.defaultTargetUser, "demo");
    assert.equal(launcherWrite?.value.defaultInstallDir, dir);
    assert.equal(launcherWrite?.value.installedBy, "builder");
    assert.ok(result.manifestPath.endsWith(path.join(dir, "installer.json")));
    assert.ok(result.rinPath.endsWith("launcher-builder"));
    assert.ok(result.rinInstallPath.endsWith("launcher-install-builder"));
  });
});

test("apply-plan child result reader returns parsed json on success", async () => {
  await withTempDir(async (dir) => {
    const resultPath = path.join(dir, "result.json");
    const errorPath = path.join(dir, "error.txt");
    await fs.writeFile(resultPath, '{"ok":true}\n', "utf8");
    await fs.writeFile(errorPath, "ignored\n", "utf8");

    assert.deepEqual(
      applyPlan.readFinalizeInstallChildResult(resultPath, errorPath, 0),
      { ok: true },
    );
  });
});

test("apply-plan child result reader surfaces child error output", async () => {
  await withTempDir(async (dir) => {
    const resultPath = path.join(dir, "result.json");
    const errorPath = path.join(dir, "error.txt");
    await fs.writeFile(errorPath, "child failed loudly\n", "utf8");

    assert.throws(
      () => applyPlan.readFinalizeInstallChildResult(resultPath, errorPath, 1),
      /child failed loudly/,
    );
  });
});

test("apply-plan child result reader falls back when child error output is missing", async () => {
  await withTempDir(async (dir) => {
    const resultPath = path.join(dir, "result.json");
    const errorPath = path.join(dir, "missing-error.txt");

    assert.throws(
      () => applyPlan.readFinalizeInstallChildResult(resultPath, errorPath, 1),
      /rin_installer_apply_failed/,
    );
  });
});

test("apply-plan child result reader rejects missing or invalid success payloads", async () => {
  await withTempDir(async (dir) => {
    const resultPath = path.join(dir, "result.json");
    const errorPath = path.join(dir, "error.txt");
    await fs.writeFile(errorPath, "ignored\n", "utf8");

    assert.throws(
      () => applyPlan.readFinalizeInstallChildResult(resultPath, errorPath, 0),
      /rin_installer_apply_result_missing/,
    );

    await fs.writeFile(resultPath, "not-json\n", "utf8");
    assert.throws(
      () => applyPlan.readFinalizeInstallChildResult(resultPath, errorPath, 0),
      /rin_installer_apply_result_missing/,
    );
  });
});

test("apply-plan child runner spawns the installer child with stable env, spinner messages, and cleanup", async () => {
  const spinnerEvents = [];
  const spawnCalls = [];
  const removed = [];
  const child = new EventEmitter();
  const result = await applyPlan.runFinalizeInstallPlanInChild(
    {
      currentUser: "builder",
      targetUser: "demo",
      installDir: "/srv/rin",
      provider: "openai",
    },
    "Publishing runtime...",
    {
      ensureNotCancelled: (value) => value,
      mkdtempSync: () => "/tmp/rin-install-demo",
      rmSync: (targetPath, options) => removed.push([targetPath, options]),
      spawn: (command, args, options) => {
        spawnCalls.push([command, args, options]);
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
      spinner: () => ({
        start(message) {
          spinnerEvents.push(["start", message]);
        },
        stop(message) {
          spinnerEvents.push(["stop", message]);
        },
      }),
      readFinalizeInstallChildResult: (resultPath, errorPath, exitCode) => {
        spinnerEvents.push(["read", resultPath, errorPath, exitCode]);
        return { ok: true, resultPath, errorPath };
      },
      processExecPath: "/usr/bin/node",
      processArgv1: "/workspace/dist/app/rin-install/main.js",
      processEnv: { BASE: "1" },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    resultPath: "/tmp/rin-install-demo/result.json",
    errorPath: "/tmp/rin-install-demo/error.txt",
  });
  assert.deepEqual(spawnCalls, [
    [
      "/usr/bin/node",
      ["/workspace/dist/app/rin-install/main.js"],
      {
        stdio: "ignore",
        env: {
          BASE: "1",
          RIN_INSTALL_APPLY_PLAN: JSON.stringify({
            currentUser: "builder",
            targetUser: "demo",
            installDir: "/srv/rin",
            provider: "openai",
          }),
          RIN_INSTALL_APPLY_RESULT: "/tmp/rin-install-demo/result.json",
          RIN_INSTALL_APPLY_ERROR: "/tmp/rin-install-demo/error.txt",
        },
      },
    ],
  ]);
  assert.deepEqual(spinnerEvents, [
    ["start", "Publishing runtime..."],
    [
      "read",
      "/tmp/rin-install-demo/result.json",
      "/tmp/rin-install-demo/error.txt",
      0,
    ],
    ["stop", "Install step complete."],
  ]);
  assert.deepEqual(removed, [
    ["/tmp/rin-install-demo", { recursive: true, force: true }],
  ]);
});

test("apply-plan child runner reports child failures and still cleans temp state", async () => {
  const spinnerEvents = [];
  const removed = [];
  const child = new EventEmitter();

  await assert.rejects(
    () =>
      applyPlan.runFinalizeInstallPlanInChild(
        {
          currentUser: "builder",
          targetUser: "demo",
          installDir: "/srv/rin",
        },
        "Publishing runtime...",
        {
          ensureNotCancelled: (value) => value,
          mkdtempSync: () => "/tmp/rin-install-demo",
          rmSync: (targetPath, options) => removed.push([targetPath, options]),
          spawn: () => {
            queueMicrotask(() => child.emit("error", new Error("spawn_boom")));
            return child;
          },
          spinner: () => ({
            start(message) {
              spinnerEvents.push(["start", message]);
            },
            stop(message) {
              spinnerEvents.push(["stop", message]);
            },
          }),
        },
      ),
    /spawn_boom/,
  );

  assert.deepEqual(spinnerEvents, [
    ["start", "Publishing runtime..."],
    ["stop", "Install step failed."],
  ]);
  assert.deepEqual(removed, [
    ["/tmp/rin-install-demo", { recursive: true, force: true }],
  ]);
});

test("apply-plan child runner falls back to import.meta entry and reports read failures after exit", async () => {
  const spinnerEvents = [];
  const spawnCalls = [];
  const removed = [];
  const child = new EventEmitter();

  await assert.rejects(
    () =>
      applyPlan.runFinalizeInstallPlanInChild(
        {
          currentUser: "builder",
          targetUser: "demo",
          installDir: "/srv/rin",
        },
        "Publishing runtime...",
        {
          ensureNotCancelled: (value) => value,
          mkdtempSync: () => "/tmp/rin-install-demo",
          rmSync: (targetPath, options) => removed.push([targetPath, options]),
          spawn: (command, args) => {
            spawnCalls.push([command, args]);
            queueMicrotask(() => child.emit("exit", 1, null));
            return child;
          },
          spinner: () => ({
            start(message) {
              spinnerEvents.push(["start", message]);
            },
            stop(message) {
              spinnerEvents.push(["stop", message]);
            },
          }),
          readFinalizeInstallChildResult: () => {
            throw new Error("child_failed");
          },
          processExecPath: "/usr/bin/node",
          processArgv1: "",
          importMetaUrl: "file:///workspace/dist/app/rin-install/main.js",
        },
      ),
    /child_failed/,
  );

  assert.deepEqual(spawnCalls, [
    ["/usr/bin/node", ["/workspace/dist/app/rin-install/main.js"]],
  ]);
  assert.deepEqual(spinnerEvents, [
    ["start", "Publishing runtime..."],
    ["stop", "Install step failed."],
  ]);
  assert.deepEqual(removed, [
    ["/tmp/rin-install-demo", { recursive: true, force: true }],
  ]);
});
