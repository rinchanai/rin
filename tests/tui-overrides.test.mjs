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

test("rin_status updates show a plain status message without touching working animation", async () => {
  await overrides.applyRinTuiOverrides();

  let statusText;
  let started = 0;
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
    ui: { requestRender() {} },
    showStatus(message) {
      statusText = message;
    },
    startWorkingAnimation() {
      started += 1;
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

  assert.equal(statusText, "Daemon connection restored.");
  assert.equal(started, 0);
});

test("rin_status end does not stop an active upstream working animation", async () => {
  await overrides.applyRinTuiOverrides();

  let stopped = 0;
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
  assert.equal(renders, 1);
});

test("rin_status freezes pending tool timers after daemon interruption", async () => {
  await overrides.applyRinTuiOverrides();

  let invalidated = 0;
  let shownStatus;
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
    showStatus(message) {
      shownStatus = message;
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
  assert.equal(shownStatus, "Waiting daemon...");
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
