import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const modelUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "subagent", "model-utils.js"),
  ).href
);
const formatUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "subagent", "format-utils.js"),
  ).href
);
const subagentIndex = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "subagent", "index.js"),
  ).href
);
const subagentService = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "subagent", "service.js"),
  ).href
);
const { SessionManager } = await import("@mariozechner/pi-coding-agent");

test("subagent model utils normalize and sort model refs", () => {
  assert.equal(modelUtils.normalizeModelRef("@openai/gpt-5"), "openai/gpt-5");
  assert.deepEqual(modelUtils.splitModelRef("openai/gpt-5"), {
    provider: "openai",
    modelId: "gpt-5",
  });
  assert.ok(modelUtils.compareModelIds("gpt-5-20260301", "gpt-5-20250101") < 0);
});

test("subagent format utils summarize results", () => {
  const persistedResult = {
    index: 1,
    prompt: "x",
    cwd: "/tmp",
    status: "done",
    exitCode: 0,
    output: "hello world",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 3,
      turns: 1,
    },
    messages: [],
    sessionMode: "persist",
    sessionPersisted: true,
    sessionId: "abc123",
    sessionName: "auth-review",
    sessionFile: "/tmp/auth-review.jsonl",
  };

  const agentText = formatUtils.buildSubagentAgentText([persistedResult]);
  const userText = formatUtils.buildSubagentUserText([persistedResult]);
  const summary = formatUtils.summarizeTaskResult(persistedResult);

  assert.ok(agentText.includes("hello world"));
  assert.ok(agentText.includes("Session: auth-review"));
  assert.ok(agentText.includes("Path: /tmp/auth-review.jsonl"));
  assert.equal(userText, agentText);
  assert.match(summary, /\[done\] \(default model\) session=auth-review — hello world$/);
  assert.ok(
    formatUtils
      .formatUsage({
        input: 1200,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      })
      .includes("↑1.2k"),
  );
});


test("subagent format utils share persisted fallback labels and final output parsing", () => {
  const results = [
    {
      index: 1,
      prompt: "first",
      status: "done",
      exitCode: 0,
      output: "  first\nresult  ",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      messages: [],
      sessionMode: "persist",
      sessionPersisted: true,
    },
    {
      index: 2,
      prompt: "second",
      status: "error",
      exitCode: 1,
      errorMessage: "line one\nline two",
      output: "",
      model: "openai/gpt-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      messages: [],
      sessionMode: "memory",
      sessionPersisted: false,
    },
  ];

  const agentText = formatUtils.buildSubagentAgentText(results);
  const userText = formatUtils.buildSubagentUserText(results);

  assert.match(agentText, /1\. \(default model\) \[session: persisted\]/);
  assert.match(userText, /Parallel subagents finished: 1\/2 succeeded/);
  assert.match(userText, /1\. \[ok\] \(default model\) \[session: persisted\] — first result/);
  assert.match(userText, /2\. \[failed\] openai\/gpt-5 — line one line two/);
  assert.equal(
    formatUtils.getFinalOutput([
      { role: "user", content: [{ type: "text", text: "ignore" }] },
      { role: "assistant", content: [{ type: "text", text: "  " }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]),
    "done",
  );
});

test("subagent task preferences are construction-time only", async () => {
  const prefs = await subagentIndex.applySubagentTaskPreferences({
    model: "openai/gpt-5",
    thinkingLevel: "xhigh",
  });

  assert.deepEqual(prefs, {
    modelRef: "openai/gpt-5",
    thinkingLevel: "xhigh",
  });
});

test("subagent service can hide builtin modules from worker runtime", () => {
  const disabled =
    subagentService.resolveSubagentDisabledBuiltinModules(["memory"]);
  assert.equal(disabled.includes("memory"), true);
  assert.equal(disabled.includes("subagent"), true);
  assert.equal(disabled.includes("rules"), false);
});

test("subagent service aggregates task state from current-run assistant messages", () => {
  const state = subagentService.collectTaskResultState([
    { role: "user", content: [{ type: "text", text: "ignore" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      provider: "openai",
      model: "gpt-5",
      stopReason: "tool_use",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 50,
        cost: { total: 0.1 },
      },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
      provider: "openai",
      model: "gpt-5-mini",
      stopReason: "end_turn",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 60,
        cost: { total: 0.02 },
      },
    },
  ]);

  assert.equal(state.output, "final answer");
  assert.equal(state.stopReason, "end_turn");
  assert.equal(state.model, "openai/gpt-5-mini");
  assert.equal(state.usage.input, 11);
  assert.equal(state.usage.output, 22);
  assert.equal(state.usage.cacheRead, 33);
  assert.equal(state.usage.cacheWrite, 44);
  assert.equal(state.usage.contextTokens, 60);
  assert.equal(state.usage.turns, 2);
  assert.ok(Math.abs(state.usage.cost - 0.12) < 1e-9);
});

test("run_subagent exposes disabledExtensions in both single and task modes", () => {
  const tools = [];
  subagentIndex.default({
    registerTool(tool) {
      tools.push(tool);
    },
    getThinkingLevel() {
      return "medium";
    },
  });
  const runTool = tools.find((tool) => tool.name === "run_subagent");
  assert.ok(runTool);
  assert.equal(runTool.parameters.properties.disabledExtensions.type, "array");
  assert.equal(
    runTool.parameters.properties.tasks.items.properties.disabledExtensions.type,
    "array",
  );
  assert.equal(runTool.parameters.properties.session.properties.keep.type, "boolean");
  assert.equal(
    runTool.parameters.properties.tasks.items.properties.session.properties.keep.type,
    "boolean",
  );
});

test("session manager can create ephemeral forks without writing a session file", async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(process.cwd(), "tmp-subagent-fork-"));
  try {
    const sessionDir = path.join(tempRoot, "sessions");
    const source = SessionManager.create(tempRoot, sessionDir);
    source.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "world" }],
      provider: "test",
      model: "demo",
    });

    const fork = subagentService.forkSessionManagerCompat(
      SessionManager,
      source.getSessionFile(),
      tempRoot,
      sessionDir,
      { persist: false },
    );
    assert.equal(fork.isPersisted(), false);
    assert.equal(fork.getSessionFile(), undefined);
    assert.equal(fork.getEntries().length, source.getEntries().length);
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});
