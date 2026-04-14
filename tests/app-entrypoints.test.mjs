import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

const builtin = await import(
  pathToFileURL(path.join(rootDir, "dist", "app", "builtin-extensions.js")).href
);
const appCli = await import(
  pathToFileURL(path.join(rootDir, "dist", "app", "rin", "main.js")).href
);
const appInstall = await import(
  pathToFileURL(path.join(rootDir, "dist", "app", "rin-install", "main.js"))
    .href
);
const appTui = await import(
  pathToFileURL(path.join(rootDir, "dist", "app", "rin-tui", "main.js")).href
);
const appWorker = await import(
  pathToFileURL(path.join(rootDir, "dist", "app", "rin-daemon", "worker.js"))
    .href
);
const appDaemon = await import(
  pathToFileURL(path.join(rootDir, "dist", "app", "rin-daemon", "daemon.js"))
    .href
);
const appKoishi = await import(
  pathToFileURL(path.join(rootDir, "dist", "app", "rin-koishi", "main.js")).href
);

test("app builtin extension manifest stays stable and includes core product extensions", () => {
  const paths = builtin.getBuiltinExtensionPaths();
  assert.equal(paths.length, 14);
  assert.deepEqual(paths, [
    path.join(rootDir, "dist", "extensions", "rules", "index.js"),
    path.join(rootDir, "dist", "extensions", "web-search", "index.js"),
    path.join(rootDir, "dist", "extensions", "fetch", "index.js"),
    path.join(rootDir, "dist", "extensions", "memory", "index.js"),
    path.join(rootDir, "dist", "extensions", "self-improve", "index.js"),
    path.join(rootDir, "dist", "extensions", "reset-system-prompt", "index.js"),
    path.join(rootDir, "dist", "extensions", "message-header", "index.js"),
    path.join(
      rootDir,
      "dist",
      "extensions",
      "freeze-session-runtime",
      "index.js",
    ),
    path.join(
      rootDir,
      "dist",
      "extensions",
      "auto-compact-continue",
      "index.js",
    ),
    path.join(rootDir, "dist", "extensions", "tui-input-compat", "index.js"),
    path.join(rootDir, "dist", "extensions", "subagent", "index.js"),
    path.join(rootDir, "dist", "extensions", "task", "index.js"),
    path.join(rootDir, "dist", "extensions", "chat", "index.js"),
    path.join(rootDir, "dist", "extensions", "token-usage", "index.js"),
  ]);
});

test("app CLI and installer wrappers delegate to core entrypoints", async () => {
  const calls = [];

  await appCli.main({
    startRinCli: async () => {
      calls.push("cli");
    },
  });
  await appInstall.main({
    startInstaller: async () => {
      calls.push("installer");
    },
  });

  assert.deepEqual(calls, ["cli", "installer"]);
});

test("app TUI worker and Koishi wrappers always inject builtin extension paths", async () => {
  const builtins = ["/tmp/ext-a.js", "/tmp/ext-b.js"];
  const seen = [];

  await appTui.main({
    getBuiltinExtensionPaths: () => builtins,
    startTui: async (options) => {
      seen.push(["tui", options]);
    },
  });
  await appWorker.main({
    getBuiltinExtensionPaths: () => builtins,
    startWorker: async (options) => {
      seen.push(["worker", options]);
    },
  });
  await appKoishi.main({
    getBuiltinExtensionPaths: () => builtins,
    startKoishi: async (options) => {
      seen.push(["koishi", options]);
    },
  });

  assert.deepEqual(seen, [
    ["tui", { additionalExtensionPaths: builtins }],
    ["worker", { additionalExtensionPaths: builtins }],
    ["koishi", { additionalExtensionPaths: builtins }],
  ]);
});

test("app daemon sidecar manifest binds both search and Koishi sidecars to the same instance id", async () => {
  const calls = [];
  const sidecars = appDaemon.buildAppDaemonSidecars(
    "/srv/rin",
    "/app/koishi.js",
    {
      pid: 4242,
      cleanupOrphanSearxngSidecars: async (agentDir) =>
        calls.push(["cleanup-search", agentDir]),
      ensureSearxngSidecar: async (agentDir, options) =>
        calls.push(["ensure-search", agentDir, options]),
      stopSearxngSidecar: async (agentDir, options) =>
        calls.push(["stop-search", agentDir, options]),
      cleanupOrphanKoishiSidecars: async (agentDir) =>
        calls.push(["cleanup-koishi", agentDir]),
      ensureKoishiSidecar: async (agentDir, options) =>
        calls.push(["ensure-koishi", agentDir, options]),
      stopKoishiSidecar: async (agentDir, options) =>
        calls.push(["stop-koishi", agentDir, options]),
    },
  );

  assert.equal(sidecars.length, 2);
  assert.equal(sidecars[0].instanceId, "daemon-4242");
  assert.equal(sidecars[1].instanceId, "daemon-4242");

  await appDaemon.ensureAppDaemonSidecars(sidecars);
  await sidecars[0].stop(sidecars[0].instanceId);
  await sidecars[1].stop(sidecars[1].instanceId);

  assert.deepEqual(calls, [
    ["cleanup-search", "/srv/rin"],
    ["ensure-search", "/srv/rin", { instanceId: "daemon-4242" }],
    ["cleanup-koishi", "/srv/rin"],
    [
      "ensure-koishi",
      "/srv/rin",
      { instanceId: "daemon-4242", entryPath: "/app/koishi.js" },
    ],
    ["stop-search", "/srv/rin", { instanceId: "daemon-4242" }],
    ["stop-koishi", "/srv/rin", { instanceId: "daemon-4242" }],
  ]);
});

test("app daemon wrapper derives worker and koishi entry paths, refreshes sidecars, and starts the core daemon", async () => {
  const builtins = ["/tmp/ext-a.js"];
  const events = [];
  const sidecars = [
    {
      instanceId: "daemon-999",
      stop: async (instanceId) => {
        events.push(["stop-sidecar", instanceId]);
      },
    },
  ];
  let intervalHandler;
  let clearedTimer;
  const processHandlers = new Map();

  await appDaemon.main({
    importMetaUrl: pathToFileURL("/repo/dist/app/rin-daemon/daemon.js").href,
    getBuiltinExtensionPaths: () => builtins,
    resolveRuntimeProfile: () => ({ agentDir: "/srv/rin" }),
    buildAppDaemonSidecars: (agentDir, koishiEntryPath) => {
      events.push(["build-sidecars", agentDir, koishiEntryPath]);
      return sidecars;
    },
    ensureAppDaemonSidecars: async (items) => {
      events.push(["ensure-sidecars", items]);
    },
    setInterval: (handler, ms) => {
      intervalHandler = handler;
      events.push(["set-interval", ms]);
      return { timer: true };
    },
    clearInterval: (timer) => {
      clearedTimer = timer;
      events.push(["clear-interval", timer]);
    },
    processOn: (event, handler) => {
      processHandlers.set(event, handler);
      events.push(["process-on", event]);
      return process;
    },
    startDaemon: async (options) => {
      events.push(["start-daemon", options]);
    },
  });

  assert.deepEqual(events.slice(0, 6), [
    ["build-sidecars", "/srv/rin", "/repo/dist/app/rin-koishi/main.js"],
    ["ensure-sidecars", sidecars],
    ["set-interval", 10000],
    ["process-on", "SIGINT"],
    ["process-on", "SIGTERM"],
    ["process-on", "exit"],
  ]);
  assert.deepEqual(events[6], [
    "start-daemon",
    {
      workerPath: "/repo/dist/app/rin-daemon/worker.js",
      additionalExtensionPaths: builtins,
    },
  ]);

  await intervalHandler();
  assert.deepEqual(events[7], ["ensure-sidecars", sidecars]);

  await processHandlers.get("SIGTERM")();
  assert.deepEqual(clearedTimer, { timer: true });
  assert.deepEqual(events.slice(-2), [
    ["clear-interval", { timer: true }],
    ["stop-sidecar", "daemon-999"],
  ]);
});
