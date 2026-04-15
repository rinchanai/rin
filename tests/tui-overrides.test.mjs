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
const themeModule = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "third_party",
      "pi-coding-agent",
      "dist",
      "modes",
      "interactive",
      "theme",
      "theme.js",
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
    ui: { terminal: { setTitle(value) { title = value; } } },
  });

  assert.equal(title, "π - demo");
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

test("rpc compaction end restores transport loader instead of leaving status empty", async () => {
  themeModule.initTheme("dark");
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

  let renders = 0;
  const ui = { requestRender() { renders += 1; } };
  const instance = {
    isInitialized: true,
    ui,
    session: {
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "working",
          label: "Working",
          connected: true,
        };
      },
    },
    statusContainer: {
      child: null,
      clear() {
        this.child = null;
      },
      addChild(child) {
        this.child = child;
      },
    },
    chatContainer: {
      clear() {},
      addChild() {},
      removeChild() {},
    },
    defaultEditor: { onEscape() {} },
    footer: { invalidate() {} },
    flushCompactionQueue() {},
    showError() {},
    showStatus() {},
    autoCompactionLoader: { stop() {} },
  };

  await interactiveModeModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    { type: "compaction_end", aborted: false, willRetry: false },
  );

  assert.equal(instance.loadingAnimation?.message, "Working...");
  instance.loadingAnimation?.stop?.();
  assert.ok(renders >= 1);
});

test("rpc agent end does not leave a stale working loader after the turn is done", async () => {
  themeModule.initTheme("dark");
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

  const ui = { requestRender() {} };
  const existingLoader = new loaderModule.Loader(ui, (x) => x, (x) => x, "Working...");
  const instance = {
    isInitialized: true,
    ui,
    session: {
      getFrontendStatusEvent() {
        return null;
      },
    },
    statusContainer: {
      clear() {},
      addChild() {},
    },
    chatContainer: { removeChild() {} },
    footer: { invalidate() {} },
    pendingTools: new Map(),
    checkShutdownRequested: async () => {},
    loadingAnimation: existingLoader,
  };

  await interactiveModeModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    { type: "agent_end" },
  );

  assert.equal(instance.loadingAnimation, undefined);
  existingLoader.stop();
});
