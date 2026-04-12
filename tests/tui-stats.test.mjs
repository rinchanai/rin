import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const stats = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "stats.js")).href
);

test("tui stats compute session stats from entries", () => {
  const entries = [
    { type: "message", message: { role: "user", content: [] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall" }],
        usage: {
          input: 10,
          output: 20,
          cacheRead: 1,
          cacheWrite: 2,
          cost: { total: 0.5 },
        },
      },
    },
    { type: "message", message: { role: "toolResult", content: [] } },
  ];
  const result = stats.computeSessionStats(
    { contextWindow: 1000 },
    "/tmp/demo",
    "sid",
    entries,
    { tokens: 33, contextWindow: 1000, percent: 3.3 },
  );
  assert.equal(result.userMessages, 1);
  assert.equal(result.assistantMessages, 1);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.toolResults, 1);
  assert.equal(result.tokens.total, 33);
});

test("tui stats reconcile pending queues trims oldest queued messages", () => {
  const steering = ["a", "b"];
  const follow = ["c", "d"];
  stats.reconcilePendingQueues(steering, follow, 2);
  assert.deepEqual(steering, []);
  assert.deepEqual(follow, ["c", "d"]);
});
