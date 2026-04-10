import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const events = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "events.js")).href
);

test("rpc session events do not refresh whole state on every stream update", async () => {
  const seen = [];
  let refreshMessages = 0;
  let refreshMessagesAndSession = 0;
  const target = {
    isStreaming: false,
    isCompacting: false,
    retryAttempt: 0,
    activeTurn: { mode: "prompt" },
    emitEvent: (event) => seen.push(event),
  };

  await events.handleRpcSessionEvent(
    target,
    { type: "message_update", message: { role: "assistant" } },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(refreshMessages, 0);
  assert.equal(refreshMessagesAndSession, 0);

  await events.handleRpcSessionEvent(
    target,
    { type: "message_end", message: { role: "assistant" } },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(refreshMessages, 1);
  assert.equal(refreshMessagesAndSession, 0);

  await events.handleRpcSessionEvent(
    target,
    { type: "agent_end" },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.isStreaming, false);
  assert.equal(target.activeTurn, null);
  assert.equal(refreshMessagesAndSession, 1);
  assert.deepEqual(seen, [
    { type: "message_update", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant" } },
    { type: "agent_end" },
  ]);
});
