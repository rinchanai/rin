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
  ).href,
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
  ).href,
);
const codingAgentModule = await import("@mariozechner/pi-coding-agent");

test("terminal title override shows only session name", async () => {
  await overrides.applyRinTuiOverrides();

  let title;
  codingAgentModule.InteractiveMode.prototype.updateTerminalTitle.call({
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

test("rpc session selector loads sessions through the daemon instead of local SessionManager", async () => {
  await overrides.applyRinTuiOverrides();

  let listed = 0;
  let renamed = [];
  let selector;
  const instance = {
    session: {
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "idle",
          label: "Idle",
          connected: true,
        };
      },
      async listSessions() {
        listed += 1;
        return [
          {
            id: "/tmp/demo.jsonl",
            title: "demo",
            subtitle: "2026-04-16T00:00:00.000Z",
            isActive: true,
          },
        ];
      },
      async renameSession(path, name) {
        renamed.push([path, name]);
      },
    },
    sessionManager: {
      getSessionFile: () => "/tmp/demo.jsonl",
      getCwd: () => "/tmp",
      getSessionDir: () => "/tmp/.sessions",
    },
    keybindings: {},
    ui: { requestRender() {} },
    showSelector(factory) {
      selector = factory(() => {}).component;
      return selector;
    },
    handleResumeSession: async () => {},
    shutdown: async () => {},
  };

  codingAgentModule.InteractiveMode.prototype.showSessionSelector.call(instance);

  const sessions = await selector.currentSessionsLoader();
  await selector.renameSession("/tmp/demo.jsonl", "renamed");

  assert.equal(listed > 0, true);
  assert.equal(sessions[0].path, "/tmp/demo.jsonl");
  assert.equal(sessions[0].name, undefined);
  assert.equal(sessions[0].firstMessage, "demo");
  assert.equal(sessions[0].modified instanceof Date, true);
  assert.deepEqual(renamed, [["/tmp/demo.jsonl", "renamed"]]);
});

test("rpc session resync rebinds runtime state and rerenders history", async () => {
  await overrides.applyRinTuiOverrides();

  let runtimeChanges = 0;
  let renders = 0;
  let historyRenders = 0;
  const ui = { requestRender() { renders += 1; } };
  const instance = {
    isInitialized: true,
    ui,
    session: {
      getFrontendStatusEvent() {
        return null;
      },
    },
    handleRuntimeSessionChange: async () => {
      runtimeChanges += 1;
    },
    renderCurrentSessionState() {
      historyRenders += 1;
    },
    statusContainer: {
      clear() {},
      addChild() {},
    },
    chatContainer: { clear() {}, addChild() {}, removeChild() {} },
    defaultEditor: { onEscape() {} },
    footer: { invalidate() {} },
    flushCompactionQueue() {},
    showError() {},
    showStatus() {},
    autoCompactionLoader: { stop() {} },
  };

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    { type: "rpc_session_resynced" },
  );

  assert.equal(runtimeChanges, 1);
  assert.equal(historyRenders, 1);
  assert.ok(renders >= 1);
});

test("rpc compaction end restores transport loader instead of leaving status empty", async () => {
  await overrides.applyRinTuiOverrides();

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

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    { type: "compaction_end", aborted: false, willRetry: false },
  );

  assert.equal(instance.loadingAnimation?.message, "Working...");
  instance.loadingAnimation?.stop?.();
  assert.ok(renders >= 1);
});

test("rpc agent end does not leave a stale working loader after the turn is done", async () => {
  await overrides.applyRinTuiOverrides();

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

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
    instance,
    { type: "agent_end" },
  );

  assert.equal(instance.loadingAnimation, undefined);
  existingLoader.stop();
});
