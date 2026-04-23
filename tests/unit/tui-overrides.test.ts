import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
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

test("local session selector reuses bound session helpers for canonicalized list and rename", async () => {
  await overrides.applyRinTuiOverrides();

  let listed = [];
  let renamed = [];
  let selector;
  const originalList = codingAgentModule.SessionManager.list;
  const originalOpen = codingAgentModule.SessionManager.open;

  codingAgentModule.SessionManager.list = async (_cwd, dir) => {
    listed.push(dir);
    return [
      {
        id: "session-1",
        title: "Legacy title",
        subtitle: "2026-04-18T00:00:00.000Z",
      },
    ];
  };
  codingAgentModule.SessionManager.open = (sessionPath) => ({
    appendSessionInfo(name) {
      renamed.push([sessionPath, name]);
    },
  });

  try {
    const instance = {
      sessionManager: {
        getSessionFile: () => "/tmp/demo.jsonl",
        getCwd: () => "/tmp/project",
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

    assert.deepEqual(listed, ["/tmp/.sessions", "/tmp/.sessions"]);
    assert.deepEqual(
      {
        id: sessions[0]?.id,
        path: sessions[0]?.path,
        name: sessions[0]?.name,
        firstMessage: sessions[0]?.firstMessage,
        modified: sessions[0]?.modified?.toISOString(),
        messageCount: sessions[0]?.messageCount,
        cwd: sessions[0]?.cwd,
        allMessagesText: sessions[0]?.allMessagesText,
      },
      {
        id: "session-1",
        path: "session-1",
        name: undefined,
        firstMessage: "Legacy title",
        modified: "2026-04-18T00:00:00.000Z",
        messageCount: 0,
        cwd: undefined,
        allMessagesText: "Legacy title",
      },
    );
    assert.deepEqual(renamed, [["/tmp/demo.jsonl", "renamed"]]);
  } finally {
    codingAgentModule.SessionManager.list = originalList;
    codingAgentModule.SessionManager.open = originalOpen;
  }
});

test("rpc session selector loads sessions through the daemon instead of local SessionManager", async () => {
  await overrides.applyRinTuiOverrides();

  let listed = 0;
  const renamed = [];
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
            path: "/tmp/demo.jsonl",
            firstMessage: "demo",
            modified: new Date("2026-04-16T00:00:00.000Z"),
            messageCount: 3,
            cwd: "/tmp",
            allMessagesText: "demo follow up",
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
  assert.equal(sessions[0].messageCount, 3);
  assert.equal(sessions[0].cwd, "/tmp");
  assert.equal(sessions[0].allMessagesText, "demo follow up");
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

test("background rpc event failures are surfaced without unhandled rejection", async () => {
  await overrides.applyRinTuiOverrides();

  let capturedHandler;
  const seenErrors = [] as string[];
  const rejections = [] as string[];
  const onUnhandledRejection = (error: any) => {
    rejections.push(String(error?.message || error || "unknown"));
  };
  process.once("unhandledRejection", onUnhandledRejection);

  try {
    const instance = {
      session: {
        subscribe(handler: (event: any) => void) {
          capturedHandler = handler;
          return () => {};
        },
      },
      async handleEvent() {
        throw new Error("rpc_session_resync_failed");
      },
      showError(message: string) {
        seenErrors.push(message);
      },
    };

    codingAgentModule.InteractiveMode.prototype.subscribeToAgent.call(instance);
    capturedHandler?.({ type: "rpc_session_resynced" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(rejections, []);
    assert.deepEqual(seenErrors, [
      "Background event error: rpc_session_resync_failed",
    ]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});

test("rpc compaction end reattaches the existing transport loader", async () => {
  await overrides.applyRinTuiOverrides();

  let renders = 0;
  const ui = { requestRender() { renders += 1; } };
  const existingLoader = new loaderModule.Loader(ui, (x) => x, (x) => x, "Working...");
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
    loadingAnimation: existingLoader,
    statusContainer: {
      child: existingLoader,
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

  assert.equal(instance.loadingAnimation, existingLoader);
  assert.equal(instance.statusContainer.child, existingLoader);
  assert.equal(instance.loadingAnimation?.message, "Working...");
  existingLoader.stop();
  assert.ok(renders >= 1);
});

test("local compaction end restores the working loader while the turn is still streaming", async () => {
  await overrides.applyRinTuiOverrides();

  let renders = 0;
  const ui = { requestRender() { renders += 1; } };
  const existingLoader = new loaderModule.Loader(ui, (x) => x, (x) => x, "Working...");
  const instance = {
    isInitialized: true,
    ui,
    session: {
      isStreaming: true,
    },
    loadingAnimation: existingLoader,
    defaultWorkingMessage: "Working...",
    statusContainer: {
      child: existingLoader,
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

  assert.equal(instance.loadingAnimation, existingLoader);
  assert.equal(instance.statusContainer.child, existingLoader);
  assert.equal(instance.loadingAnimation?.message, "Working...");
  existingLoader.stop();
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

test("signal handler override routes SIGINT through interactive Ctrl+C handling", async () => {
  await overrides.applyRinTuiOverrides();

  const originalOn = process.on;
  const originalOff = process.off;
  const handlers = new Map();

  process.on = function patchedOn(event, handler) {
    const next = handlers.get(event) || [];
    next.push(handler);
    handlers.set(event, next);
    return this;
  };
  process.off = function patchedOff(event, handler) {
    const next = (handlers.get(event) || []).filter((item) => item !== handler);
    if (next.length) handlers.set(event, next);
    else handlers.delete(event);
    return this;
  };

  try {
    let ctrlCCount = 0;
    const instance = {
      signalCleanupHandlers: [],
      ui: { stopped: false },
      handleCtrlC() {
        ctrlCCount += 1;
      },
      unregisterSignalHandlers() {
        return codingAgentModule.InteractiveMode.prototype.unregisterSignalHandlers.call(
          this,
        );
      },
    };

    codingAgentModule.InteractiveMode.prototype.registerSignalHandlers.call(
      instance,
    );

    const sigintHandlers = handlers.get("SIGINT") || [];
    assert.equal(sigintHandlers.length, 1);

    sigintHandlers[0]();
    sigintHandlers[0]();
    assert.equal(ctrlCCount, 2);

    codingAgentModule.InteractiveMode.prototype.unregisterSignalHandlers.call(
      instance,
    );
    assert.equal((handlers.get("SIGINT") || []).length, 0);
  } finally {
    process.on = originalOn;
    process.off = originalOff;
  }
});

test("signal handler override ignores SIGINT while the TUI is stopped", async () => {
  await overrides.applyRinTuiOverrides();

  const originalOn = process.on;
  const originalOff = process.off;
  const handlers = new Map();

  process.on = function patchedOn(event, handler) {
    const next = handlers.get(event) || [];
    next.push(handler);
    handlers.set(event, next);
    return this;
  };
  process.off = function patchedOff(event, handler) {
    const next = (handlers.get(event) || []).filter((item) => item !== handler);
    if (next.length) handlers.set(event, next);
    else handlers.delete(event);
    return this;
  };

  try {
    let ctrlCCount = 0;
    const instance = {
      signalCleanupHandlers: [],
      ui: { stopped: true },
      handleCtrlC() {
        ctrlCCount += 1;
      },
      unregisterSignalHandlers() {
        return codingAgentModule.InteractiveMode.prototype.unregisterSignalHandlers.call(
          this,
        );
      },
    };

    codingAgentModule.InteractiveMode.prototype.registerSignalHandlers.call(
      instance,
    );

    const sigintHandlers = handlers.get("SIGINT") || [];
    assert.equal(sigintHandlers.length, 1);
    sigintHandlers[0]();
    assert.equal(ctrlCCount, 0);
  } finally {
    process.on = originalOn;
    process.off = originalOff;
  }
});
