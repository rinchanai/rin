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

test("rin_status end always stops lingering working animation", async () => {
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

  const loadingAnimation = {
    stop() {
      stopped += 1;
    },
  };

  const instance = {
    session: { isStreaming: true, isCompacting: false },
    loadingAnimation,
    ui: {
      requestRender() {
        renders += 1;
      },
    },
    stopWorkingAnimation() {
      if (this.loadingAnimation) {
        this.loadingAnimation.stop();
        this.loadingAnimation = undefined;
      }
    },
  };

  await interactiveModeModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    {
      type: "rin_status",
      phase: "end",
    },
  );

  assert.equal(stopped, 1);
  assert.equal(renders, 1);
  assert.equal(instance.loadingAnimation, undefined);
});

test("rin_status freezes pending tool timers after daemon interruption", async () => {
  await overrides.applyRinTuiOverrides();

  let invalidated = 0;
  let retryStopped = 0;
  let compactionStopped = 0;
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
    retryLoader: { stop() { retryStopped += 1; } },
    autoCompactionLoader: { stop() { compactionStopped += 1; } },
    statusContainer: { clear() {} },
    session: { isStreaming: true, isCompacting: false },
    ui: { requestRender() {} },
    startWorkingAnimation() {},
    showStatus() {},
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
  assert.equal(retryStopped, 1);
  assert.equal(compactionStopped, 1);
  assert.equal(instance.retryLoader, undefined);
  assert.equal(instance.autoCompactionLoader, undefined);
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
