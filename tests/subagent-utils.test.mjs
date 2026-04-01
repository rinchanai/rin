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
    },
  ]);
  assert.ok(text.includes("subagent results=1 failed=0"));
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

test("subagent applies model and thinking without session-level persistence", async () => {
  const calls = [];
  const session = {
    modelRegistry: {
      find(provider, modelId) {
        if (provider === "openai" && modelId === "gpt-5") {
          return { provider, id: modelId, reasoning: true };
        }
        return undefined;
      },
      hasConfiguredAuth() {
        return true;
      },
    },
    getAvailableThinkingLevels() {
      return ["off", "minimal", "low", "medium"];
    },
    agent: {
      setModel(model) {
        calls.push(["agent.setModel", model.provider, model.id]);
      },
      setThinkingLevel(level) {
        calls.push(["agent.setThinkingLevel", level]);
      },
    },
    setModel() {
      calls.push(["session.setModel"]);
    },
    setThinkingLevel() {
      calls.push(["session.setThinkingLevel"]);
    },
  };

  await subagentIndex.applySubagentTaskPreferences(session, {
    model: "openai/gpt-5",
    thinkingLevel: "xhigh",
  });

  assert.deepEqual(calls, [
    ["agent.setModel", "openai", "gpt-5"],
    ["agent.setThinkingLevel", "medium"],
  ]);
});
