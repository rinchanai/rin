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
