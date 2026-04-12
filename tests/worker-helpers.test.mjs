import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const workerHelpers = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "worker-helpers.js"),
  ).href
);

test("worker helpers split command args and format stats", () => {
  assert.deepEqual(
    workerHelpers.splitCommandArgs(`model openai/gpt-5 "high detail"`),
    ["model", "openai/gpt-5", "high detail"],
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
      modelRegistry: { getAvailable: async () => [] },
      setModel: async () => {},
      setThinkingLevel: async () => {},
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

  assert.deepEqual(calls, [
    ["abort"],
    ["newSession"],
    ["switchSession", "/tmp/sessions/abc.jsonl"],
  ]);
});

test("runBuiltinCommand renders changelog entries from the vendored changelog", async () => {
  const runtime = {
    session: {
      abort: async () => {},
      compact: async () => {},
      reload: async () => {},
      getSessionStats: () => ({ sessionId: "s" }),
      sessionManager: {
        getCwd: () => "/tmp/project",
        getSessionDir: () => "/tmp/sessions",
      },
      modelRegistry: { getAvailable: async () => [] },
      setModel: async () => {},
      setThinkingLevel: async () => {},
    },
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
  };

  const result = await workerHelpers.runBuiltinCommand(runtime, "/changelog", {
    SessionManager: { list: async () => [] },
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /## \[/);
});

test("runBuiltinCommand prefers SessionManager.listAll for /resume discovery", async () => {
  const calls = [];
  const runtime = {
    session: {
      abort: async () => {},
      compact: async () => {},
      reload: async () => {},
      getSessionStats: () => ({ sessionId: "s" }),
      sessionManager: {
        getCwd: () => "/tmp/project",
        getSessionDir: () => "/tmp/sessions",
      },
      modelRegistry: { getAvailable: async () => [] },
      setModel: async () => {},
      setThinkingLevel: async () => {},
    },
    newSession: async () => ({ cancelled: false }),
    switchSession: async (sessionPath) => {
      calls.push(sessionPath);
      return { cancelled: false };
    },
  };

  const deps = {
    SessionManager: {
      listAll: async () => [
        {
          id: "abc",
          name: "named session",
          path: "/tmp/sessions/abc.jsonl",
        },
      ],
      list: async () => {
        throw new Error("list_should_not_be_used_when_listAll_exists");
      },
    },
  };

  const listing = await workerHelpers.runBuiltinCommand(
    runtime,
    "/resume",
    deps,
  );
  assert.equal(listing.handled, true);
  assert.match(listing.text, /Available sessions:/);
  assert.match(listing.text, /abc — named session/);

  const resumed = await workerHelpers.runBuiltinCommand(
    runtime,
    "/resume abc",
    deps,
  );
  assert.equal(resumed.handled, true);
  assert.match(resumed.text, /Resumed session: abc/);
  assert.deepEqual(calls, ["/tmp/sessions/abc.jsonl"]);
});

test("runBuiltinCommand lists available models and reports missing matches", async () => {
  const runtime = {
    session: {
      abort: async () => {},
      compact: async () => {},
      reload: async () => {},
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
      setModel: async () => {},
      setThinkingLevel: async () => {},
    },
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
  };

  const listing = await workerHelpers.runBuiltinCommand(runtime, "/model", {
    SessionManager: { list: async () => [] },
  });
  assert.equal(listing.handled, true);
  assert.match(listing.text, /Available models:/);
  assert.match(listing.text, /openai\/gpt-5/);
  assert.match(listing.text, /anthropic\/claude-sonnet/);

  const missing = await workerHelpers.runBuiltinCommand(
    runtime,
    "/model openai/missing",
    {
      SessionManager: { list: async () => [] },
    },
  );
  assert.equal(missing.handled, true);
  assert.match(missing.text, /Model not found: openai\/missing/);
});

test("runBuiltinCommand sets model and optional thinking level", async () => {
  const calls = [];
  const selectedModel = { provider: "openai", id: "gpt-5" };
  const runtime = {
    session: {
      abort: async () => {},
      compact: async () => {},
      reload: async () => {},
      getSessionStats: () => ({ sessionId: "s" }),
      sessionManager: {
        getCwd: () => "/tmp/project",
        getSessionDir: () => "/tmp/sessions",
      },
      modelRegistry: {
        getAvailable: async () => [selectedModel],
      },
      setModel: async (model) => {
        calls.push(["setModel", model]);
      },
      setThinkingLevel: async (level) => {
        calls.push(["setThinkingLevel", level]);
      },
    },
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
  };

  const result = await workerHelpers.runBuiltinCommand(
    runtime,
    "/model openai/gpt-5 high",
    {
      SessionManager: { list: async () => [] },
    },
  );
  assert.equal(result.handled, true);
  assert.match(result.text, /Model set to: openai\/gpt-5 \(high\)/);
  assert.deepEqual(calls, [
    ["setModel", selectedModel],
    ["setThinkingLevel", "high"],
  ]);
});

test("runBuiltinCommand reports model usage errors and empty model catalogs", async () => {
  const calls = [];
  const runtime = {
    session: {
      abort: async () => {},
      compact: async () => {},
      reload: async () => {},
      getSessionStats: () => ({ sessionId: "s" }),
      sessionManager: {
        getCwd: () => "/tmp/project",
        getSessionDir: () => "/tmp/sessions",
      },
      modelRegistry: {
        getAvailable: async () => [],
      },
      setModel: async (model) => {
        calls.push(["setModel", model]);
      },
      setThinkingLevel: async (level) => {
        calls.push(["setThinkingLevel", level]);
      },
    },
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
  };

  const listing = await workerHelpers.runBuiltinCommand(runtime, "/model", {
    SessionManager: { list: async () => [] },
  });
  assert.equal(listing.handled, true);
  assert.equal(listing.text, "No models available.");

  const usage = await workerHelpers.runBuiltinCommand(
    runtime,
    "/model openai",
    {
      SessionManager: { list: async () => [] },
    },
  );
  assert.equal(usage.handled, true);
  assert.match(
    usage.text,
    /Usage: \/model <provider\/model> \[thinking-level\]/,
  );
  assert.deepEqual(calls, []);
});

test("runBuiltinCommand handles compact reload session and plain text inputs", async () => {
  const calls = [];
  const runtime = {
    session: {
      abort: async () => {},
      compact: async (note) => {
        calls.push(["compact", note]);
      },
      reload: async () => {
        calls.push(["reload"]);
      },
      getSessionStats: () => ({
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        totalMessages: 4,
        userMessages: 2,
        assistantMessages: 1,
        toolResults: 1,
        toolCalls: 3,
        tokens: { total: 20, input: 8, output: 9, cacheRead: 2, cacheWrite: 1 },
        cost: 0.02,
      }),
      sessionManager: {
        getCwd: () => "/tmp/project",
        getSessionDir: () => "/tmp/sessions",
      },
      modelRegistry: { getAvailable: async () => [] },
      setModel: async () => {},
      setThinkingLevel: async () => {},
    },
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
  };

  const compacted = await workerHelpers.runBuiltinCommand(
    runtime,
    "/compact keep only the conclusion",
    {
      SessionManager: { list: async () => [] },
    },
  );
  assert.equal(compacted.handled, true);
  assert.equal(compacted.text, "Compacted session.");

  const reloaded = await workerHelpers.runBuiltinCommand(runtime, "/reload", {
    SessionManager: { list: async () => [] },
  });
  assert.equal(reloaded.handled, true);
  assert.match(
    reloaded.text,
    /Reloaded extensions, prompts, skills, and themes/,
  );

  const sessionInfo = await workerHelpers.runBuiltinCommand(
    runtime,
    "/session",
    {
      SessionManager: { list: async () => [] },
    },
  );
  assert.equal(sessionInfo.handled, true);
  assert.match(sessionInfo.text, /Session ID: session-1/);
  assert.match(sessionInfo.text, /Tool Calls: 3/);

  const plainText = await workerHelpers.runBuiltinCommand(runtime, "hello", {
    SessionManager: { list: async () => [] },
  });
  assert.deepEqual(plainText, { handled: false });

  assert.deepEqual(calls, [
    ["compact", "keep only the conclusion"],
    ["reload"],
  ]);
});

test("runBuiltinCommand reports empty and missing resume targets", async () => {
  const calls = [];
  const runtime = {
    session: {
      abort: async () => {},
      compact: async () => {},
      reload: async () => {},
      getSessionStats: () => ({ sessionId: "s" }),
      sessionManager: {
        getCwd: () => "/tmp/project",
        getSessionDir: () => "/tmp/sessions",
      },
      modelRegistry: { getAvailable: async () => [] },
      setModel: async () => {},
      setThinkingLevel: async () => {},
    },
    newSession: async () => ({ cancelled: false }),
    switchSession: async (sessionPath) => {
      calls.push(sessionPath);
      return { cancelled: false };
    },
  };

  const empty = await workerHelpers.runBuiltinCommand(runtime, "/resume", {
    SessionManager: { list: async () => [] },
  });
  assert.equal(empty.handled, true);
  assert.equal(empty.text, "No sessions available.");

  const missing = await workerHelpers.runBuiltinCommand(
    runtime,
    "/resume missing",
    {
      SessionManager: {
        list: async () => [{ id: "abc", path: "/tmp/sessions/abc.jsonl" }],
      },
    },
  );
  assert.equal(missing.handled, true);
  assert.equal(missing.text, "Session not found: missing");
  assert.deepEqual(calls, []);
});
