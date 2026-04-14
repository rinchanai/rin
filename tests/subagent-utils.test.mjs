import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const modelUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "subagent", "model-utils.js"),
  ).href
);
const formatUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "subagent", "format-utils.js"),
  ).href
);
const subagentIndex = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "subagent", "index.js"),
  ).href
);
const subagentService = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "src", "core", "subagent", "service.js"),
  ).href
);

test("subagent model utils normalize and sort model refs", () => {
  assert.equal(modelUtils.normalizeModelRef("@openai/gpt-5"), "openai/gpt-5");
  assert.deepEqual(modelUtils.splitModelRef("openai/gpt-5"), {
    provider: "openai",
    modelId: "gpt-5",
  });
  assert.ok(modelUtils.compareModelIds("gpt-5-20260301", "gpt-5-20250101") < 0);
});

test("subagent format utils summarize results", () => {
  const text = formatUtils.buildSubagentAgentText([
    {
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
    },
  ]);
  assert.ok(text.includes("hello world"));
  assert.ok(text.includes("Session: auth-review"));
  assert.ok(text.includes("Path: /tmp/auth-review.jsonl"));
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

test("subagent service can hide builtin extensions from worker runtime", () => {
  const paths = subagentService.resolveSubagentExtensionPaths(["memory"]);
  const normalized = paths.map((entry) => entry.replaceAll("\\", "/"));
  assert.equal(
    normalized.some((entry) => entry.endsWith("/extensions/memory/index.js")),
    false,
  );
  assert.equal(
    normalized.some((entry) => entry.endsWith("/extensions/subagent/index.js")),
    false,
  );
  assert.equal(
    normalized.some((entry) => entry.endsWith("/extensions/rules/index.js")),
    true,
  );
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
});
