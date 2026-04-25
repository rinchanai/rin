import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const gui = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "gui.js"))
    .href
);

test("installer GUI starts by default only for Windows interactive installs", () => {
  assert.equal(gui.shouldStartGuiInstaller([], "win32", {}), true);
  assert.equal(gui.shouldStartGuiInstaller(["--gui"], "linux", {}), true);
  assert.equal(gui.shouldStartGuiInstaller(["--tui"], "win32", {}), false);
  assert.equal(gui.shouldStartGuiInstaller(["--no-gui"], "win32", {}), false);
  assert.equal(
    gui.shouldStartGuiInstaller([], "win32", { RIN_INSTALL_APPLY_PLAN: "{}" }),
    false,
  );
  assert.equal(
    gui.shouldStartGuiInstaller([], "win32", { RIN_INSTALL_MODE: "update" }),
    false,
  );
});

test("installer GUI args parse local host, ephemeral port, and browser opening switch", () => {
  assert.deepEqual(
    gui.parseGuiInstallerArgs([
      "--gui",
      "--host",
      "0.0.0.0",
      "--port=0",
      "--no-open",
    ]),
    {
      host: "0.0.0.0",
      port: 0,
      open: false,
    },
  );
  assert.deepEqual(
    gui.parseGuiInstallerArgs(["--host=localhost", "--port", "4321", "--open"]),
    {
      host: "localhost",
      port: 4321,
      open: true,
    },
  );
  assert.throws(
    () => gui.parseGuiInstallerArgs(["--port", "70000"]),
    /rin_installer_gui_invalid_port:70000/,
  );
});

test("installer GUI plan reuses installer plan text and escapes the HTML shell", () => {
  const plan = gui.buildGuiInstallerPlan({
    language: "zh-CN",
    currentUser: "alice",
    targetUser: "bob",
    installDir: "/home/bob/.rin",
    provider: "github-copilot",
    modelId: "gpt-5.1",
    thinkingLevel: "high",
    authAvailable: true,
    setDefaultTarget: false,
  });
  assert.equal(plan.language, "zh-CN");
  assert.equal(plan.targetUser, "bob");
  assert.equal(plan.provider, "github-copilot");
  assert.equal(plan.modelId, "gpt-5.1");
  assert.equal(plan.thinkingLevel, "high");
  assert.equal(plan.authAvailable, true);
  assert.match(plan.safety, /YOLO mode|YOLO/);
  assert.match(plan.planText, /bob/);
  assert.match(plan.planText, /github-copilot/);

  const html = gui.buildGuiInstallerHtml();
  assert.match(html, /Rin Installer/);
  assert.match(html, /\/api\/plan/);
  assert.match(html, /\/api\/models/);
  assert.doesNotMatch(html, /<script src=/);
});

test("installer GUI normalizes local model choices for browser selection", () => {
  assert.deepEqual(
    gui.normalizeGuiInstallerModelChoices([
      { provider: "openai", id: "plain", reasoning: false, available: false },
      {
        provider: "copilot",
        id: "reasoning",
        reasoning: true,
        available: true,
      },
      { provider: "", id: "ignored", reasoning: true, available: true },
    ]),
    [
      {
        provider: "copilot",
        id: "reasoning",
        reasoning: true,
        available: true,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      },
      {
        provider: "openai",
        id: "plain",
        reasoning: false,
        available: false,
        thinkingLevels: ["off"],
      },
    ],
  );
});
