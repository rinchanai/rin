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
const launcherHints = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "launcher-hints.js"),
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
    chatDescription: "telegram",
    chatDetail: "Chat bridge token: [saved]",
  });
  assert.ok(plan.includes("Target daemon user: bob"));
  assert.ok(plan.includes("Model auth status: ready"));
  assert.ok(!plan.includes("Rin safety boundary:"));
  assert.ok(!plan.includes("`rin --std` → std TUI for the target user"));
  assert.ok(plan.includes("Chat bridge: telegram"));

  const safety = interactive.buildInstallSafetyBoundaryText();
  assert.ok(safety.includes("YOLO mode"));
  assert.ok(safety.includes("memory extraction"));
  assert.ok(safety.includes("chat-bridge-triggered agent runs"));

  const initExit = interactive.buildPostInstallInitExitText({
    currentUser: "alice",
    targetUser: "bob",
  });
  assert.ok(initExit.includes("open Rin: rin"));
  assert.ok(!initExit.includes("-u bob"));
  assert.ok(initExit.includes("/init"));
});

test("launcher hints keep post-install commands on the saved user-scoped launcher", () => {
  assert.equal(launcherHints.buildLauncherCommand(), "rin");
  assert.equal(launcherHints.buildLauncherCommand("doctor"), "rin doctor");
  assert.equal(launcherHints.buildLauncherCommand("start"), "rin start");
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

test("promptProviderSetup always requires choosing a provider", async () => {
  const selectCalls = [];
  const authCalls = [];
  const prompt = {
    ensureNotCancelled(value) {
      return value;
    },
    async select(options) {
      selectCalls.push(options.message);
      if (options.message === "Choose a provider to authenticate and use.")
        return "openai";
      if (options.message === "Choose a model.") return "gpt-5";
      if (options.message === "Choose the default thinking level.")
        return "medium";
      throw new Error(`unexpected select prompt: ${options.message}`);
    },
    async text() {
      throw new Error("text prompt should not be used in this test");
    },
    async confirm() {
      throw new Error(
        "provider setup must not allow skipping provider selection",
      );
    },
  };

  const result = await interactive.promptProviderSetup(
    prompt,
    "/tmp/demo",
    () => ({}),
    {
      async loadModelChoices() {
        return [
          {
            provider: "openai",
            id: "gpt-5",
            reasoning: true,
            available: false,
          },
          {
            provider: "openai",
            id: "gpt-4.1",
            reasoning: false,
            available: false,
          },
        ];
      },
      async configureProviderAuth(provider, installDir) {
        authCalls.push({ provider, installDir });
        return {
          available: true,
          authKind: "api_key",
          authData: { openai: { type: "api_key", key: "demo" } },
        };
      },
    },
  );

  assert.deepEqual(selectCalls, [
    "Choose a provider to authenticate and use.",
    "Choose a model.",
    "Choose the default thinking level.",
  ]);
  assert.deepEqual(authCalls, [
    { provider: "openai", installDir: "/tmp/demo" },
  ]);
  assert.equal(result.provider, "openai");
  assert.equal(result.modelId, "gpt-5");
  assert.equal(result.thinkingLevel, "medium");
  assert.equal(result.authResult.available, true);
});

test("promptProviderSetup fails when no models are available", async () => {
  await assert.rejects(
    interactive.promptProviderSetup(
      {
        ensureNotCancelled(value) {
          return value;
        },
        async select() {
          throw new Error("select should not be reached without models");
        },
        async text() {
          throw new Error("text should not be reached without models");
        },
        async confirm() {
          throw new Error("confirm should not be reached without models");
        },
      },
      "/tmp/demo",
      () => ({}),
      {
        async loadModelChoices() {
          return [];
        },
      },
    ),
    /rin_installer_no_models_available/,
  );
});
