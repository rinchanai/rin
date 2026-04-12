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

test("terminal title override shows only session name", async () => {
  await overrides.applyRinTuiOverrides();

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

  let title;
  interactiveModeModule.InteractiveMode.prototype.updateTerminalTitle.call({
    sessionManager: { getSessionName: () => "demo" },
    ui: {
      terminal: {
        setTitle(value) {
          title = value;
        },
      },
    },
  });

  assert.equal(title, "π - demo");
});

test("loader stop clears render interval", () => {
  let renders = 0;
  const loader = new loaderModule.Loader(
    {
      requestRender() {
        renders += 1;
      },
    },
    (x) => x,
    (x) => x,
    "demo",
  );
  assert.notEqual(loader.intervalId, null);
  loader.stop();
  assert.equal(loader.intervalId, null);
  assert.ok(renders >= 1);
});
