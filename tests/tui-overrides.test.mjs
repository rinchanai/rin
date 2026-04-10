import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

const overrides = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "upstream-overrides.js"),
  ).href
);
const loaderModule = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "node_modules",
      "@mariozechner",
      "pi-tui",
      "dist",
      "components",
      "loader.js",
    ),
  ).href
);

test("rin_status shows waiting daemon only while active work is interrupted", async () => {
  await overrides.applyRinTuiOverrides();

  let startedWith;
  const interactiveModeModule = await import(
    pathToFileURL(
      path.join(
        rootDir,
        "third_party",
        "pi-coding-agent",
        "dist",
        "modes",
        "interactive",
        "interactive-mode.js",
      ),
    ).href
  );

  const instance = {
    session: { isStreaming: true, isCompacting: false },
    ui: { requestRender() {} },
    startWorkingAnimation(message) {
      startedWith = message;
    },
  };

  await interactiveModeModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    {
      type: "rin_status",
      phase: "update",
      message: "Waiting daemon...",
      statusText: "Daemon connection restored.",
    },
  );

  assert.equal(startedWith, "Waiting daemon...");
});

test("rin_status end keeps active work in working state", async () => {
  await overrides.applyRinTuiOverrides();

  let stopped = 0;
  let startedWith;
  let renders = 0;
  const interactiveModeModule = await import(
    pathToFileURL(
      path.join(
        rootDir,
        "third_party",
        "pi-coding-agent",
        "dist",
        "modes",
        "interactive",
        "interactive-mode.js",
      ),
    ).href
  );

  const instance = {
    defaultWorkingMessage: "Working...",
    session: { isStreaming: true, isCompacting: false },
    loadingAnimation: {
      stop() {
        stopped += 1;
      },
    },
    ui: {
      requestRender() {
        renders += 1;
      },
    },
    startWorkingAnimation(message) {
      startedWith = message;
    },
    stopWorkingAnimation() {
      stopped += 1;
    },
  };

  await interactiveModeModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    {
      type: "rin_status",
      phase: "end",
    },
  );

  assert.equal(stopped, 0);
  assert.equal(startedWith, "Working...");
  assert.equal(renders, 1);
});

test("rin_status end keeps waiting-daemon state while reconnect is still unresolved", async () => {
  await overrides.applyRinTuiOverrides();

  let stopped = 0;
  let startedWith;
  const interactiveModeModule = await import(
    pathToFileURL(
      path.join(
        rootDir,
        "third_party",
        "pi-coding-agent",
        "dist",
        "modes",
        "interactive",
        "interactive-mode.js",
      ),
    ).href
  );

  const instance = {
    defaultWorkingMessage: "Working...",
    session: { isStreaming: true, isCompacting: false, rpcStatusMessage: "Waiting daemon..." },
    ui: { requestRender() {} },
    startWorkingAnimation(message) {
      startedWith = message;
    },
    stopWorkingAnimation() {
      stopped += 1;
    },
  };

  await interactiveModeModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    {
      type: "rin_status",
      phase: "end",
    },
  );

  assert.equal(stopped, 0);
  assert.equal(startedWith, "Waiting daemon...");
});

test("rin_status restores working after reconnect when work remains active", async () => {
  await overrides.applyRinTuiOverrides();

  let startedWith;
  const interactiveModeModule = await import(
    pathToFileURL(
      path.join(
        rootDir,
        "third_party",
        "pi-coding-agent",
        "dist",
        "modes",
        "interactive",
        "interactive-mode.js",
      ),
    ).href
  );

  const instance = {
    defaultWorkingMessage: "Working...",
    session: { isStreaming: true, isCompacting: false },
    ui: { requestRender() {} },
    startWorkingAnimation(message) {
      startedWith = message;
    },
  };

  await interactiveModeModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    {
      type: "rin_status",
      phase: "end",
    },
  );

  assert.equal(startedWith, "Working...");
});

test("rin_status freezes pending tool timers after daemon interruption", async () => {
  await overrides.applyRinTuiOverrides();

  let invalidated = 0;
  let startedWith;
  const interval = setInterval(() => {}, 1000);
  const interactiveModeModule = await import(
    pathToFileURL(
      path.join(
        rootDir,
        "third_party",
        "pi-coding-agent",
        "dist",
        "modes",
        "interactive",
        "interactive-mode.js",
      ),
    ).href
  );

  const component = {
    rendererState: { interval, startedAt: 1, endedAt: undefined },
    invalidate() {
      invalidated += 1;
    },
  };

  const instance = {
    pendingTools: new Map([["tool-1", component]]),
    session: { isStreaming: true, isCompacting: false },
    ui: { requestRender() {} },
    startWorkingAnimation(message) {
      startedWith = message;
    },
  };

  await interactiveModeModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    {
      type: "rin_status",
      phase: "update",
      message: "Waiting daemon...",
    },
  );

  assert.equal(component.rendererState.interval, undefined);
  assert.equal(typeof component.rendererState.endedAt, "number");
  assert.equal(invalidated, 1);
  assert.equal(startedWith, "Waiting daemon...");
});

test("loader stop clears render interval", () => {
  let renders = 0;
  const loader = new loaderModule.Loader(
    { requestRender() { renders += 1; } },
    (x) => x,
    (x) => x,
    "demo",
  );
  assert.notEqual(loader.intervalId, null);
  loader.stop();
  assert.equal(loader.intervalId, null);
  assert.ok(renders >= 1);
});
