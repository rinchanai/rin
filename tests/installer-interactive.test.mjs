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
