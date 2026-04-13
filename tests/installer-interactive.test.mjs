import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const interactive = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "interactive.js"),
  ).href
);

test("installer interactive helpers describe dir state and plan text", () => {
  const existing = interactive.describeInstallDirState("/tmp/demo", {
    exists: true,
    entryCount: 2,
    sample: ["a", "b"],
  });
  assert.equal(existing.title, "Existing directory");
  assert.ok(existing.text.includes("keep unknown files untouched"));

  const created = interactive.describeInstallDirState("/tmp/demo", {
    exists: false,
    entryCount: 0,
    sample: [],
  });
  assert.equal(created.title, "Install directory");
  assert.ok(created.text.includes("Directory will be created"));

  const plan = interactive.buildInstallPlanText({
    currentUser: "alice",
    targetUser: "bob",
    installDir: "/home/bob/.rin",
    provider: "openai",
    modelId: "gpt-5",
    thinkingLevel: "medium",
    authAvailable: true,
    koishiDescription: "telegram",
    koishiDetail: "Koishi token: [saved]",
  });
  assert.ok(plan.includes("Target daemon user: bob"));
  assert.ok(plan.includes("Model auth status: ready"));
  assert.ok(!plan.includes("Rin safety boundary:"));
  assert.ok(!plan.includes("`rin --std` → std TUI for the target user"));

  const safety = interactive.buildInstallSafetyBoundaryText();
  assert.ok(safety.includes("YOLO mode"));
  assert.ok(safety.includes("memory extraction"));

  const initExit = interactive.buildPostInstallInitExitText({
    currentUser: "alice",
    targetUser: "bob",
  });
  assert.ok(initExit.includes("open Rin: rin -u bob"));
  assert.ok(initExit.includes("/init"));
});

test("installer interactive helpers compute final requirements", () => {
  const elevated = interactive.buildFinalRequirements({
    installServiceNow: true,
    needsElevatedWrite: false,
    needsElevatedService: true,
  });
  assert.ok(elevated.some((line) => line.includes("use sudo/doas")));

  const local = interactive.buildFinalRequirements({
    installServiceNow: false,
    needsElevatedWrite: false,
    needsElevatedService: false,
  });
  assert.ok(
    local.some((line) => line.includes("skip daemon service installation")),
  );
});

function createPromptHarness(overrides = {}) {
  const selectValues = [...(overrides.selectValues ?? [])];
  const textValues = [...(overrides.textValues ?? [])];
  const confirmValues = [...(overrides.confirmValues ?? [])];
  const calls = [];
  return {
    calls,
    prompt: {
      ensureNotCancelled(value) {
        return value;
      },
      async select(options) {
        calls.push(["select", options.message]);
        return selectValues.shift();
      },
      async text(options) {
        calls.push(["text", options.message]);
        return textValues.shift();
      },
      async confirm(options) {
        calls.push(["confirm", options.message]);
        return confirmValues.shift();
      },
    },
  };
}

test("installer interactive target selection handles existing users, new users, and empty candidate lists", async () => {
  const existingHarness = createPromptHarness({
    selectValues: ["existing", "bob"],
    textValues: ["/srv/bob-rin"],
  });
  const existing = await interactive.promptTargetInstall(
    existingHarness.prompt,
    "alice",
    [
      {
        name: "alice",
        uid: 1000,
        gid: 1000,
        home: "/home/alice",
        shell: "/bin/bash",
      },
      {
        name: "bob",
        uid: 1001,
        gid: 1001,
        home: "/srv/bob",
        shell: "/bin/bash",
      },
    ],
    (user) => `/home/${user}`,
  );
  assert.deepEqual(existing, {
    cancelled: false,
    targetUser: "bob",
    installDir: "/srv/bob-rin",
    defaultDir: "/home/bob/.rin",
    existingCandidates: [
      {
        name: "bob",
        uid: 1001,
        gid: 1001,
        home: "/srv/bob",
        shell: "/bin/bash",
      },
    ],
    allUsers: [
      {
        name: "alice",
        uid: 1000,
        gid: 1000,
        home: "/home/alice",
        shell: "/bin/bash",
      },
      {
        name: "bob",
        uid: 1001,
        gid: 1001,
        home: "/srv/bob",
        shell: "/bin/bash",
      },
    ],
  });

  const newHarness = createPromptHarness({
    selectValues: ["new"],
    textValues: ["rinbot", "/srv/rinbot/.rin"],
  });
  const created = await interactive.promptTargetInstall(
    newHarness.prompt,
    "alice",
    [
      {
        name: "alice",
        uid: 1000,
        gid: 1000,
        home: "/home/alice",
        shell: "/bin/bash",
      },
    ],
    (user) => `/users/${user}`,
  );
  assert.equal(created.cancelled, false);
  assert.equal(created.targetUser, "rinbot");
  assert.equal(created.installDir, "/srv/rinbot/.rin");
  assert.equal(created.defaultDir, "/users/rinbot/.rin");

  const fallbackHarness = createPromptHarness({
    selectValues: ["existing", "solo"],
    textValues: ["/home/solo/.rin"],
  });
  const fallback = await interactive.promptTargetInstall(
    fallbackHarness.prompt,
    "solo",
    [
      {
        name: "solo",
        uid: 1000,
        gid: 1000,
        home: "/home/solo",
        shell: "/bin/bash",
      },
    ],
    (user) => `/home/${user}`,
  );
  assert.equal(fallback.cancelled, false);
  assert.equal(fallback.targetUser, "solo");
  assert.deepEqual(fallback.existingCandidates, [
    {
      name: "solo",
      uid: 1000,
      gid: 1000,
      home: "/home/solo",
      shell: "/bin/bash",
    },
  ]);
});

test("installer interactive provider setup supports skipped, api-key, and oauth flows", async () => {
  const skippedHarness = createPromptHarness({ confirmValues: [false] });
  assert.deepEqual(
    await interactive.promptProviderSetup(
      skippedHarness.prompt,
      "/srv/rin",
      () => ({}),
    ),
    {
      provider: "",
      modelId: "",
      thinkingLevel: "",
      authResult: { available: false, authKind: "skipped", authData: {} },
    },
  );

  const apiKeyHarness = createPromptHarness({
    confirmValues: [true],
    selectValues: ["openai", "gpt-5", "high"],
  });
  const apiKey = await interactive.promptProviderSetup(
    apiKeyHarness.prompt,
    "/srv/rin",
    () => ({}),
    {
      loadModelChoices: async () => [
        { provider: "openai", id: "gpt-5", reasoning: true, available: false },
        {
          provider: "openai",
          id: "gpt-4.1",
          reasoning: false,
          available: true,
        },
      ],
      configureProviderAuth: async () => ({
        available: true,
        authKind: "api_key",
        authData: { openai: { type: "api_key" } },
      }),
    },
  );
  assert.equal(apiKey.provider, "openai");
  assert.equal(apiKey.modelId, "gpt-5");
  assert.equal(apiKey.thinkingLevel, "high");
  assert.equal(apiKey.authResult.authKind, "api_key");

  const oauthHarness = createPromptHarness({
    confirmValues: [true],
    selectValues: ["github", "copilot-chat", "off"],
  });
  const oauth = await interactive.promptProviderSetup(
    oauthHarness.prompt,
    "/srv/rin",
    () => ({}),
    {
      loadModelChoices: async () => [
        {
          provider: "github",
          id: "copilot-chat",
          reasoning: false,
          available: false,
        },
      ],
      configureProviderAuth: async () => ({
        available: true,
        authKind: "oauth",
        authData: { github: { type: "oauth" } },
      }),
    },
  );
  assert.equal(oauth.provider, "github");
  assert.equal(oauth.modelId, "copilot-chat");
  assert.equal(oauth.thinkingLevel, "off");
  assert.equal(oauth.authResult.authKind, "oauth");
});

test("installer interactive provider setup rejects missing model inventories deterministically", async () => {
  const harness = createPromptHarness({ confirmValues: [true] });
  await assert.rejects(
    () =>
      interactive.promptProviderSetup(harness.prompt, "/srv/rin", () => ({}), {
        loadModelChoices: async () => [],
      }),
    /rin_installer_no_models_available/,
  );

  const wrongProviderHarness = createPromptHarness({
    confirmValues: [true],
    selectValues: ["anthropic"],
  });
  await assert.rejects(
    () =>
      interactive.promptProviderSetup(
        wrongProviderHarness.prompt,
        "/srv/rin",
        () => ({}),
        {
          loadModelChoices: async () => [
            {
              provider: "openai",
              id: "gpt-5",
              reasoning: true,
              available: true,
            },
          ],
          configureProviderAuth: async () => ({
            available: true,
            authKind: "existing",
            authData: {},
          }),
        },
      ),
    /rin_installer_no_models_for_provider:anthropic/,
  );
});

test("installer interactive koishi setup supports disabled telegram and onebot flows", async () => {
  const disabledHarness = createPromptHarness({ confirmValues: [false] });
  assert.deepEqual(
    await interactive.promptKoishiSetup(disabledHarness.prompt),
    {
      koishiDescription: "disabled for now",
      koishiDetail: "",
      koishiConfig: null,
    },
  );

  const telegramHarness = createPromptHarness({
    confirmValues: [true],
    selectValues: ["telegram"],
    textValues: ["123456:ABC"],
  });
  const telegram = await interactive.promptKoishiSetup(telegramHarness.prompt);
  assert.equal(telegram.koishiDescription, "telegram");
  assert.deepEqual(telegram.koishiConfig, {
    telegram: { token: "123456:ABC", protocol: "polling", slash: true },
  });

  const onebotHarness = createPromptHarness({
    confirmValues: [true],
    selectValues: ["onebot"],
    textValues: ["ws://127.0.0.1:6700"],
  });
  const onebot = await interactive.promptKoishiSetup(onebotHarness.prompt);
  assert.equal(onebot.koishiDescription, "onebot");
  assert.deepEqual(onebot.koishiConfig, {
    onebot: {
      endpoint: "ws://127.0.0.1:6700",
      protocol: "ws",
      selfId: "",
      token: "",
    },
  });
});
