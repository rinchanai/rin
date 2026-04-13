import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const launch = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "launch.js")).href
);
const usage = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "usage.js")).href
);
const store = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "token-usage", "store.js"))
    .href
);

function baseParsed(overrides = {}) {
  return {
    command: "",
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

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cli-usage-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function fakeRuntimeEnv() {
  return {
    RIN_DAEMON_SOCKET_PATH: "/run/user/1001/rin-daemon/daemon.sock",
    RIN_INVOKING_SYSTEM_USER: "owner",
    RIN_DIR: "/srv/rin",
    PI_CODING_AGENT_DIR: "/srv/rin",
  };
}

test("launchDefaultRin rejects missing install metadata and conflicting tmux modes", async () => {
  await assert.rejects(
    launch.launchDefaultRin(
      baseParsed({ explicitUser: false, hasSavedInstall: false }),
    ),
    /rin_not_installed/,
  );
  await assert.rejects(
    launch.launchDefaultRin(
      baseParsed({ tmuxSession: "work", tmuxList: true }),
    ),
    /rin_tmux_mode_conflict/,
  );
});

test("launchDefaultRin runs tmux list mode and suppresses expected no-server stderr", async () => {
  const stdout = [];
  const stderr = [];
  const exits = [];

  await launch.launchDefaultRin(baseParsed({ tmuxList: true }), {
    repoRootFromHere: () => "/repo",
    currentUser: "owner",
    buildTuiRuntimeEnv: () => fakeRuntimeEnv(),
    runTargetCommandCapture: async (targetUser, argv, env, cwd) => {
      assert.equal(targetUser, "demo");
      assert.deepEqual(argv, [
        "tmux",
        "-L",
        "rin-demo",
        "list-sessions",
        "-F",
        "#S",
      ]);
      assert.equal(
        env.RIN_DAEMON_SOCKET_PATH,
        "/run/user/1001/rin-daemon/daemon.sock",
      );
      assert.equal(env.RIN_INVOKING_SYSTEM_USER, "owner");
      assert.equal(cwd, "/repo");
      return {
        code: 1,
        stdout: "",
        stderr: "no server running on /tmp/tmux-1000/default\n",
      };
    },
    stdoutWrite: (text) => stdout.push(text),
    stderrWrite: (text) => stderr.push(text),
    exit: (code) => {
      exits.push(code);
    },
  });

  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, []);
  assert.deepEqual(exits, [0]);
});

test("launchDefaultRin forwards tmux session and default tui launches with stable args", async () => {
  const calls = [];
  const exits = [];

  await launch.launchDefaultRin(
    baseParsed({ tmuxSession: "alpha", std: true, passthrough: ["--foo"] }),
    {
      repoRootFromHere: () => "/repo",
      currentUser: "owner",
      buildTuiRuntimeEnv: () => fakeRuntimeEnv(),
      runTargetCommand: async (targetUser, argv, env, cwd) => {
        calls.push([targetUser, argv, env, cwd]);
        return 17;
      },
      exit: (code) => {
        exits.push(code);
      },
    },
  );

  await launch.launchDefaultRin(baseParsed({ passthrough: ["--bar"] }), {
    repoRootFromHere: () => "/repo",
    currentUser: "owner",
    buildTuiRuntimeEnv: () => fakeRuntimeEnv(),
    runTargetCommand: async (targetUser, argv, env, cwd) => {
      calls.push([targetUser, argv, env, cwd]);
      return 23;
    },
    exit: (code) => {
      exits.push(code);
    },
  });

  assert.deepEqual(calls[0][1], [
    "tmux",
    "-L",
    "rin-demo",
    "new-session",
    "-A",
    "-s",
    "alpha",
    process.execPath,
    "/repo/dist/app/rin-tui/main.js",
    "--std",
    "--foo",
  ]);
  assert.equal(calls[0][2].RIN_INVOKING_SYSTEM_USER, "owner");
  assert.equal(
    calls[0][2].RIN_DAEMON_SOCKET_PATH,
    "/run/user/1001/rin-daemon/daemon.sock",
  );
  assert.equal(calls[0][3], "/repo");

  assert.deepEqual(calls[1][1], [
    process.execPath,
    "/repo/dist/app/rin-tui/main.js",
    "--rpc",
    "--bar",
  ]);
  assert.deepEqual(exits, [17, 23]);
});

test("parseUsageArgs keeps CLI passthrough flags out of usage options", () => {
  const parsed = usage.parseUsageArgs([
    "usage",
    "--user",
    "demo",
    "--tmux",
    "alpha",
    "--std",
    "--group-by",
    "provider_model,capability",
    "--filter",
    "source=extension",
    "--from",
    "7d",
    "--to",
    "2026-04-12",
    "--limit",
    "5",
    "--order-by",
    "rows",
    "--direction",
    "asc",
    "--events",
  ]);

  assert.deepEqual(parsed.groupBy, ["provider_model", "capability"]);
  assert.deepEqual(parsed.filters, [{ key: "source", value: "extension" }]);
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.orderBy, "rows");
  assert.equal(parsed.direction, "asc");
  assert.equal(parsed.events, true);
  assert.match(parsed.from, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(parsed.to, "2026-04-12T23:59:59.999Z");
});

test("parseUsageArgs rejects invalid filters and unknown flags", () => {
  assert.throws(
    () => usage.parseUsageArgs(["usage", "--filter", "broken"]),
    /invalid_filter:broken/,
  );
  assert.throws(
    () => usage.parseUsageArgs(["usage", "--mystery"]),
    /unknown_usage_arg:--mystery/,
  );
});

test("renderUsageReport produces dashboard, aggregate, event, and dimension views", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-1",
        timestamp: "2026-04-10T10:00:00.000Z",
        sessionId: "s1",
        sessionName: "chat-1",
        eventType: "message_end",
        source: "runtime",
        provider: "openai-codex",
        model: "gpt-5.4",
        capabilityKey: "assistant:text",
        totalTokens: 120,
        inputTokens: 100,
        outputTokens: 20,
        costTotal: 0.12,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-2",
        timestamp: "2026-04-10T10:05:00.000Z",
        sessionId: "s1",
        sessionName: "chat-1",
        eventType: "tool_execution_end",
        source: "extension",
        toolName: "read",
        capabilityKey: "tool:read",
        totalTokens: 0,
      },
      root,
    );

    const dashboard = usage.renderUsageReport(
      root,
      usage.parseUsageArgs(["usage"]),
    );
    assert.match(dashboard, /token usage dashboard/);
    assert.match(dashboard, /top models/);
    assert.match(dashboard, /recent token events/);

    const aggregate = usage.renderUsageReport(
      root,
      usage.parseUsageArgs(["usage", "--group-by", "source", "--include-zero"]),
    );
    assert.match(aggregate, /aggregate/);
    assert.match(aggregate, /source/);
    assert.match(aggregate, /runtime/);
    assert.match(aggregate, /extension/);

    const events = usage.renderUsageReport(
      root,
      usage.parseUsageArgs(["usage", "--events", "--limit", "5"]),
    );
    assert.match(events, /timestamp/);
    assert.match(events, /tool:read/);

    const dimensions = usage.renderUsageReport(
      root,
      usage.parseUsageArgs(["usage", "--dimensions"]),
    );
    assert.match(dimensions, /supported dimensions:/);
    assert.match(dimensions, /provider_model/);
  });
});

test("runUsage forwards to the target user runtime when the caller is not the target user", async () => {
  const stdout = [];
  const parsed = baseParsed({ command: "usage" });

  await usage.runUsage(parsed, ["usage", "--events", "--limit", "5"], {
    createTargetExecutionContext: () => ({
      isTargetUser: false,
      repoRoot: "/repo",
      installDir: "/srv/rin",
      capture(argv) {
        assert.deepEqual(argv, [
          process.execPath,
          "/repo/dist/app/rin/main.js",
          "__usage_internal",
          "--events",
          "--limit",
          "5",
        ]);
        return "forwarded-report\n";
      },
    }),
    stdoutWrite: (text) => stdout.push(text),
  });

  assert.deepEqual(stdout, ["forwarded-report\n"]);
});

test("runUsage and runUsageInternal honor help mode without rendering the report", async () => {
  let usageHelpCalls = 0;
  let internalHelpCalls = 0;

  await usage.runUsage(baseParsed({ command: "usage" }), ["usage", "--help"], {
    printUsageHelp: () => {
      usageHelpCalls += 1;
    },
    renderUsageReport: () => {
      throw new Error("usage_help_should_not_render");
    },
  });

  await usage.runUsageInternal(["--help"], {
    printUsageHelp: () => {
      internalHelpCalls += 1;
    },
    renderUsageReport: () => {
      throw new Error("internal_help_should_not_render");
    },
  });

  assert.equal(usageHelpCalls, 1);
  assert.equal(internalHelpCalls, 1);
});

test("runUsage renders locally for the target user and runUsageInternal logs the generated report", async () => {
  const usageLogs = [];
  const internalLogs = [];

  await usage.runUsage(
    baseParsed({ command: "usage" }),
    ["usage", "--dimensions"],
    {
      createTargetExecutionContext: () => ({
        isTargetUser: true,
        installDir: "/srv/rin",
      }),
      renderUsageReport: (agentDir, options) => {
        assert.equal(agentDir, "/srv/rin");
        assert.equal(options.dimensions, true);
        return "local-report";
      },
      log: (text) => usageLogs.push(text),
    },
  );

  await usage.runUsageInternal(["--events"], {
    renderUsageReport: (agentDir, options) => {
      assert.equal(options.events, true);
      assert.equal(typeof agentDir, "string");
      return "internal-report";
    },
    log: (text) => internalLogs.push(text),
  });

  assert.deepEqual(usageLogs, ["local-report"]);
  assert.deepEqual(internalLogs, ["internal-report"]);
});
