import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const main = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "main.js")).href
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

function createCliStub({
  matchedCommandName = "",
  options = {},
  parseCalls,
  helpCalls,
}) {
  return {
    matchedCommandName,
    parse(argv, config) {
      parseCalls.push([argv, config]);
      return { options };
    },
    outputHelp() {
      helpCalls.push("help");
    },
  };
}

test("parseCommandName recognizes supported commands and ignores unknown ones", () => {
  assert.equal(main.parseCommandName("update"), "update");
  assert.equal(main.parseCommandName("start"), "start");
  assert.equal(main.parseCommandName("stop"), "stop");
  assert.equal(main.parseCommandName("restart"), "restart");
  assert.equal(main.parseCommandName("doctor"), "doctor");
  assert.equal(main.parseCommandName("usage"), "usage");
  assert.equal(main.parseCommandName("bogus"), "");
  assert.equal(main.parseCommandName(""), "");
});

test("startRinCli fast-paths __usage_internal and usage help before CLI parsing", async () => {
  const usageInternalCalls = [];
  const parseCalls = [];
  const helpCalls = [];

  await main.startRinCli({
    argv: ["node", "rin", "__usage_internal", "--events", "--limit", "5"],
    createCli: () => createCliStub({ parseCalls, helpCalls }),
    runUsageInternal: async (argv) => {
      usageInternalCalls.push(argv);
    },
  });
  await main.startRinCli({
    argv: ["node", "rin", "usage", "--help"],
    createCli: () => createCliStub({ parseCalls, helpCalls }),
    runUsageInternal: async (argv) => {
      usageInternalCalls.push(argv);
    },
  });

  assert.deepEqual(usageInternalCalls, [
    ["--events", "--limit", "5"],
    ["--help"],
  ]);
  assert.deepEqual(parseCalls, []);
  assert.deepEqual(helpCalls, []);
});

test("startRinCli outputs top-level help without dispatching handlers", async () => {
  const parseCalls = [];
  const helpCalls = [];
  const dispatched = [];

  await main.startRinCli({
    argv: ["node", "rin", "--help"],
    createCli: () =>
      createCliStub({
        parseCalls,
        helpCalls,
        options: { help: true },
      }),
    resolveParsedArgs: () => {
      throw new Error("should_not_resolve_args");
    },
    runUpdate: async () => dispatched.push("update"),
    launchDefaultRin: async () => dispatched.push("launch"),
  });

  assert.equal(parseCalls.length, 1);
  assert.deepEqual(helpCalls, ["help"]);
  assert.deepEqual(dispatched, []);
});

test("startRinCli dispatches each supported command through resolved parsed args", async () => {
  const routes = [
    ["update", "runUpdate"],
    ["start", "runStart"],
    ["stop", "runStop"],
    ["restart", "runRestart"],
    ["doctor", "runDoctor"],
    ["usage", "runUsage"],
  ];

  for (const [command, routeName] of routes) {
    const resolved = baseParsed({ command });
    const seen = [];
    await main.startRinCli({
      argv: ["node", "rin", command, "--user", "demo"],
      createCli: () =>
        createCliStub({
          matchedCommandName: command,
          options: { user: "demo" },
          parseCalls: [],
          helpCalls: [],
        }),
      resolveParsedArgs: (parsedCommand, options, rawArgv) => {
        seen.push([parsedCommand, options, rawArgv]);
        return resolved;
      },
      runUpdate: async (parsed) => {
        if (routeName === "runUpdate") seen.push(parsed);
      },
      runStart: async (parsed) => {
        if (routeName === "runStart") seen.push(parsed);
      },
      runStop: async (parsed) => {
        if (routeName === "runStop") seen.push(parsed);
      },
      runRestart: async (parsed) => {
        if (routeName === "runRestart") seen.push(parsed);
      },
      runDoctor: async (parsed) => {
        if (routeName === "runDoctor") seen.push(parsed);
      },
      runUsage: async (parsed, rawArgv) => {
        if (routeName === "runUsage") seen.push(parsed, rawArgv);
      },
      launchDefaultRin: async () => {
        throw new Error(`unexpected_launch:${command}`);
      },
    });

    assert.deepEqual(seen[0], [
      command,
      { user: "demo" },
      [command, "--user", "demo"],
    ]);
    assert.equal(seen[1], resolved);
    if (command === "usage") {
      assert.deepEqual(seen[2], ["usage", "--user", "demo"]);
    } else {
      assert.equal(seen.length, 2);
    }
  }
});

test("startRinCli launches default Rin when no known subcommand is matched", async () => {
  const launched = [];
  const resolved = baseParsed({ passthrough: ["--foo"] });

  await main.startRinCli({
    argv: ["node", "rin", "--foo"],
    createCli: () =>
      createCliStub({
        matchedCommandName: "",
        options: {},
        parseCalls: [],
        helpCalls: [],
      }),
    resolveParsedArgs: (command, options, rawArgv) => {
      assert.equal(command, "");
      assert.deepEqual(options, {});
      assert.deepEqual(rawArgv, ["--foo"]);
      return resolved;
    },
    launchDefaultRin: async (parsed) => {
      launched.push(parsed);
    },
  });

  assert.deepEqual(launched, [resolved]);
});

test("startRinCli trims matched command names before dispatch and tolerates unknown names", async () => {
  const parsedCommands = [];
  const launches = [];

  await main.startRinCli({
    argv: ["node", "rin", "usage"],
    createCli: () =>
      createCliStub({
        matchedCommandName: " usage ",
        options: {},
        parseCalls: [],
        helpCalls: [],
      }),
    safeString: (value) => String(value),
    resolveParsedArgs: (command) => {
      parsedCommands.push(command);
      return baseParsed({ command });
    },
    runUsage: async () => {
      parsedCommands.push("dispatched-usage");
    },
  });

  await main.startRinCli({
    argv: ["node", "rin", "mystery"],
    createCli: () =>
      createCliStub({
        matchedCommandName: " mystery ",
        options: {},
        parseCalls: [],
        helpCalls: [],
      }),
    resolveParsedArgs: (command) => {
      parsedCommands.push(command);
      return baseParsed({ command });
    },
    launchDefaultRin: async (parsed) => {
      launches.push(parsed.command);
    },
  });

  assert.deepEqual(parsedCommands, ["usage", "dispatched-usage", ""]);
  assert.deepEqual(launches, [""]);
});
