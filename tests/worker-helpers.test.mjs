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
