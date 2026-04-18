import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const workerHelpers = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "worker-helpers.js"),
  ).href,
);

function createAuthStorageFixture() {
  return {
    list: () => ["gemini"],
    get: () => ({ type: "api_key", key: "secret" }),
    getOAuthProviders: () => [
      { id: "gemini", name: "Gemini", usesCallbackServer: 0 },
    ],
  };
}

function createSessionFixture() {
  return {
    extensionRunner: {
      getRegisteredCommands: () => [
        {
          invocationName: "  resume  ",
          description: "  Resume a session.  ",
        },
        {
          name: "resume",
          description: "duplicate entry should be ignored",
        },
      ],
    },
    promptTemplates: [
      {
        name: "  polish  ",
        description: "  Rewrite the final reply.  ",
        sourceInfo: { file: "prompt-a" },
      },
    ],
    resourceLoader: {
      getSkills: () => ({
        skills: [
          {
            name: "  cleanup  ",
            description: "  Remove stale files.  ",
            sourceInfo: { file: "skill-a" },
          },
        ],
      }),
    },
    modelRegistry: {
      authStorage: createAuthStorageFixture(),
    },
  };
}

test("worker helpers split command args and format stats", () => {
  assert.deepEqual(
    workerHelpers.splitCommandArgs(`model openai/gpt-5 "high detail"`),
    ["model", "openai/gpt-5", "high detail"],
  );
  assert.deepEqual(
    workerHelpers.splitCommandArgs(`  resume   'session one'  ""  `),
    ["resume", "session one", ""],
  );
  const text = workerHelpers.formatSessionStats({
    sessionId: "s1",
    sessionFile: "",
    totalMessages: 3,
    userMessages: 1,
    assistantMessages: 1,
    toolResults: 1,
    toolCalls: 2,
    tokens: { total: 10, input: 4, output: 5, cacheRead: 1, cacheWrite: 0 },
    cost: 0.01,
  });
  assert.ok(text.includes("Session ID: s1"));
  assert.ok(text.includes("Tool Calls: 2"));
});

test("worker helpers expose normalized slash commands and oauth state", () => {
  const session = createSessionFixture();
  const commands = workerHelpers.getSlashCommands(session);

  assert.equal(commands.filter((command) => command.name === "resume").length, 1);
  assert.ok(
    commands.some(
      (command) =>
        command.name === "polish" &&
        command.description === "Rewrite the final reply." &&
        command.source === "prompt",
    ),
  );
  assert.ok(
    commands.some(
      (command) =>
        command.name === "skill:cleanup" &&
        command.description === "Remove stale files." &&
        command.source === "skill",
    ),
  );
  assert.equal(commands.some((command) => command.name === "model"), true);
  assert.deepEqual(workerHelpers.getOAuthState(session), {
    credentials: {
      gemini: { type: "api_key" },
    },
    providers: [
      {
        id: "gemini",
        name: "Gemini",
        usesCallbackServer: false,
      },
    ],
  });
});


test("getSessionState exposes worker-owned turn activity separately from streaming", () => {
  const state = workerHelpers.getSessionState(
    {
      model: null,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile: "/tmp/demo.jsonl",
      sessionId: "session-1",
      sessionName: "demo",
      autoCompactionEnabled: true,
      messages: [],
      pendingMessageCount: 0,
    },
    { turnActive: true },
  );

  assert.equal(state.turnActive, true);
  assert.equal(state.isStreaming, false);
});

test("runBuiltinCommand uses runtime for session replacement commands", async () => {
  const calls = [];
  const runtime = {
    session: {
      abort: async () => {
        calls.push(["abort"]);
      },
      compact: async () => {
        calls.push(["compact"]);
      },
      reload: async () => {
        calls.push(["reload"]);
      },
      getSessionStats: () => ({ sessionId: "s" }),
      sessionManager: {
        getCwd: () => "/tmp/project",
        getSessionDir: () => "/tmp/sessions",
      },
      modelRegistry: {
        getAvailable: async () => [
          { provider: "openai", id: "gpt-5" },
          { provider: "anthropic", id: "claude-sonnet" },
        ],
      },
      setModel: async (model) => {
        calls.push(["setModel", `${model.provider}/${model.id}`]);
      },
      setThinkingLevel: async (level) => {
        calls.push(["setThinkingLevel", level]);
      },
    },
    newSession: async () => {
      calls.push(["newSession"]);
      return { cancelled: false };
    },
    switchSession: async (sessionPath) => {
      calls.push(["switchSession", sessionPath]);
      return { cancelled: false };
    },
  };

  const resultAbort = await workerHelpers.runBuiltinCommand(runtime, "/abort", {
    SessionManager: { list: async () => [] },
  });
  assert.equal(resultAbort.handled, true);

  const resultNew = await workerHelpers.runBuiltinCommand(runtime, "/new", {
    SessionManager: { list: async () => [] },
  });
  assert.equal(resultNew.handled, true);

  const resultResume = await workerHelpers.runBuiltinCommand(
    runtime,
    "/resume abc",
    {
      SessionManager: {
        list: async () => [{ id: "abc", path: "/tmp/sessions/abc.jsonl" }],
      },
    },
  );
  assert.equal(resultResume.handled, true);
  assert.match(resultResume.text, /Resumed session: abc/);

  const resultListModels = await workerHelpers.runBuiltinCommand(
    runtime,
    "/model",
    { SessionManager: { list: async () => [] } },
  );
  assert.match(resultListModels.text, /Available models:/);
  assert.match(resultListModels.text, /openai\/gpt-5/);

  const resultSetModel = await workerHelpers.runBuiltinCommand(
    runtime,
    "/model openai/gpt-5 high",
    { SessionManager: { list: async () => [] } },
  );
  assert.match(resultSetModel.text, /Model set to: openai\/gpt-5 \(high\)/);

  const resultMissingModel = await workerHelpers.runBuiltinCommand(
    runtime,
    "/model missing",
    { SessionManager: { list: async () => [] } },
  );
  assert.match(resultMissingModel.text, /Usage: \/model/);

  assert.deepEqual(calls, [
    ["abort"],
    ["newSession"],
    ["switchSession", "/tmp/sessions/abc.jsonl"],
    ["setModel", "openai/gpt-5"],
    ["setThinkingLevel", "high"],
  ]);
});
