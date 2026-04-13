import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const doctor = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "doctor.js")).href
);
const control = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "control.js")).href
);

function baseParsed(overrides = {}) {
  return {
    command: "doctor",
    targetUser: "demo",
    installDir: "/srv/rin",
    std: false,
    tmuxSession: "",
    tmuxList: false,
    passthrough: [],
    explicitUser: true,
    hasSavedInstall: true,
    ...overrides,
  };
}

function createContext(overrides = {}) {
  const calls = [];
  const context = {
    targetUser: "demo",
    installDir: "/srv/rin",
    socketPath: "/run/user/1000/rin-daemon/daemon.sock",
    systemctl: "/usr/bin/systemctl",
    canConnectSocket: async () => true,
    queryDaemonStatus: async () => ({
      workerCount: 1,
      workers: [
        {
          id: "worker-1",
          pid: 4242,
          role: "interactive",
          attachedConnections: 2,
          pendingResponses: 0,
          isStreaming: false,
          isCompacting: false,
          sessionFile: "/srv/rin/session.jsonl",
        },
      ],
      webSearch: {
        runtime: { ready: true },
        instances: [
          {
            instanceId: "search-a",
            pid: 3001,
            alive: true,
            port: 18080,
            baseUrl: "http://127.0.0.1:18080",
          },
        ],
      },
      koishi: {
        instances: [
          {
            instanceId: "koishi-a",
            pid: 4001,
            alive: true,
            entryPath: "/srv/rin/koishi.js",
          },
        ],
      },
    }),
    capture(argv, options) {
      calls.push(["capture", argv, options]);
      if (argv.includes("status")) {
        return "Loaded: loaded\nActive: active (running)\n";
      }
      if (argv[0] === "journalctl") {
        return "line-1\nline-2\n";
      }
      return "";
    },
    exec(argv, options) {
      calls.push(["exec", argv, options]);
    },
    ...overrides,
  };
  return { context, calls };
}

test("rin doctor reports daemon, worker, web-search, koishi, and service status surfaces", async () => {
  const output = [];
  const { context, calls } = createContext();

  await doctor.runDoctor(baseParsed(), {
    createTargetExecutionContext: () => context,
    log: (text) => output.push(text),
  });

  const text = output[0] || "";
  assert.match(text, /targetUser=demo/);
  assert.match(text, /installDir=\/srv\/rin/);
  assert.match(text, /socketReady=yes/);
  assert.match(text, /webSearchRuntimeReady=yes/);
  assert.match(text, /webSearchInstance=search-a pid=3001 alive=yes/);
  assert.match(text, /koishiInstance=koishi-a pid=4001 alive=yes/);
  assert.match(text, /daemonWorker=worker-1 pid=4242 role=interactive/);
  assert.match(text, /serviceUnit=rin-daemon-demo\.service/);
  assert.match(text, /serviceJournal=rin-daemon-demo\.service/);
  assert.ok(
    calls.some(
      ([kind, argv]) => kind === "capture" && argv[0] === "/usr/bin/systemctl",
    ),
  );
  assert.ok(
    calls.some(
      ([kind, argv]) => kind === "capture" && argv[0] === "journalctl",
    ),
  );
});

test("rin doctor skips daemon status query and service logs when the socket is unavailable", async () => {
  const output = [];
  let queried = 0;
  const { context, calls } = createContext({
    systemctl: "",
    canConnectSocket: async () => false,
    queryDaemonStatus: async () => {
      queried += 1;
      return {};
    },
  });

  await doctor.runDoctor(baseParsed(), {
    createTargetExecutionContext: () => context,
    log: (text) => output.push(text),
  });

  const text = output[0] || "";
  assert.match(text, /socketReady=no/);
  assert.match(text, /serviceManager=none/);
  assert.match(text, /webSearchRuntimeReady=no/);
  assert.match(text, /koishiInstanceCount=0/);
  assert.equal(queried, 0);
  assert.deepEqual(calls, []);
});

test("rin doctor falls back to captured service stderr when systemctl status fails", async () => {
  const output = [];
  const { context } = createContext({
    capture(argv) {
      if (argv.includes("status")) {
        const error = new Error("status failed");
        error.stderr = "Loaded: loaded\nActive: failed\n";
        throw error;
      }
      if (argv[0] === "journalctl") return "journal-line\n";
      return "";
    },
  });

  await doctor.runDoctor(baseParsed(), {
    createTargetExecutionContext: () => context,
    log: (text) => output.push(text),
  });

  const text = output[0] || "";
  assert.match(text, /serviceStatus:\nLoaded: loaded\nActive: failed/);
  assert.match(text, /serviceJournal=rin-daemon-demo\.service/);
});

test("rin control start prefers managed services and restarts the unit on start", async () => {
  const logs = [];
  const { context, calls } = createContext();

  await control.runStart(baseParsed({ command: "start" }), {
    createTargetExecutionContext: () => context,
    ensureDaemonAvailable: async () => {
      throw new Error("should_not_fallback_start");
    },
    log: (text) => logs.push(text),
  });

  assert.deepEqual(logs, ["rin start complete: rin-daemon-demo.service"]);
  assert.deepEqual(calls, [
    [
      "capture",
      ["/usr/bin/systemctl", "--user", "daemon-reload"],
      { stdio: "ignore" },
    ],
    [
      "capture",
      ["/usr/bin/systemctl", "--user", "status", "rin-daemon-demo.service"],
      { stdio: "ignore" },
    ],
    [
      "exec",
      ["/usr/bin/systemctl", "--user", "restart", "rin-daemon-demo.service"],
      undefined,
    ],
  ]);
});

test("rin control falls back to daemon bootstrap and pkill paths when no managed service exists", async () => {
  const logs = [];
  const ensureCalls = [];
  const captureCalls = [];
  const context = {
    targetUser: "demo",
    installDir: "/srv/demo.rin+test",
    systemctl: "",
    capture(argv, options) {
      captureCalls.push([argv, options]);
      return "";
    },
    exec() {
      throw new Error("should_not_exec_service");
    },
  };

  await control.runStart(baseParsed({ command: "start" }), {
    createTargetExecutionContext: () => context,
    ensureDaemonAvailable: async (ctx) => {
      ensureCalls.push(ctx.installDir);
    },
    log: (text) => logs.push(text),
  });
  await control.runStop(baseParsed({ command: "stop" }), {
    createTargetExecutionContext: () => context,
    requireTool: () => "/usr/bin/pkill",
    log: (text) => logs.push(text),
  });

  assert.deepEqual(ensureCalls, ["/srv/demo.rin+test"]);
  assert.equal(logs[0], "rin start complete");
  assert.equal(logs[1], "rin stop complete");
  assert.deepEqual(captureCalls, [
    [
      [
        "/usr/bin/pkill",
        "-f",
        "/srv/demo\\.rin\\+test/app/.*/dist/(app/rin-daemon/daemon\\.js|daemon\\.js)",
      ],
      { stdio: "ignore" },
    ],
  ]);
});

test("rin control restart reuses stop/start fallbacks and logs the final completion", async () => {
  const logs = [];
  const ensureCalls = [];
  const captureCalls = [];
  const context = {
    targetUser: "demo",
    installDir: "/srv/rin",
    systemctl: "",
    capture(argv, options) {
      captureCalls.push([argv, options]);
      return "";
    },
    exec() {
      throw new Error("should_not_exec_service");
    },
  };

  await control.runRestart(baseParsed({ command: "restart" }), {
    createTargetExecutionContext: () => context,
    ensureDaemonAvailable: async () => {
      ensureCalls.push("start-fallback");
    },
    requireTool: () => "/usr/bin/pkill",
    log: (text) => logs.push(text),
  });

  assert.deepEqual(ensureCalls, ["start-fallback"]);
  assert.equal(logs.at(-1), "rin restart complete");
  assert.ok(logs.includes("rin stop complete"));
  assert.ok(logs.includes("rin start complete"));
  assert.equal(captureCalls.length, 1);
});
