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

test("rpc session events drive refresh and turn state transitions without over-refreshing", async () => {
  const seen = [];
  let refreshMessages = 0;
  let refreshMessagesAndSession = 0;
  const target = {
    isStreaming: false,
    isCompacting: false,
    retryAttempt: 0,
    activeTurn: { mode: "prompt" },
    remoteTurnRunning: false,
    setRemoteTurnRunning(value) {
      this.remoteTurnRunning = value;
      this.isStreaming = value;
    },
    emitEvent: (event) => seen.push(event),
  };

  const onRefreshMessages = async () => {
    refreshMessages += 1;
  };
  const onRefreshMessagesAndSession = async () => {
    refreshMessagesAndSession += 1;
  };

  await events.handleRpcSessionEvent(
    target,
    { type: "message_update", message: { role: "assistant" } },
    onRefreshMessages,
    onRefreshMessagesAndSession,
  );
  assert.equal(refreshMessages, 0);
  assert.equal(refreshMessagesAndSession, 0);

  await events.handleRpcSessionEvent(
    target,
    { type: "agent_start" },
    onRefreshMessages,
    onRefreshMessagesAndSession,
  );
  assert.equal(target.isStreaming, true);
  assert.equal(target.remoteTurnRunning, true);

  await events.handleRpcSessionEvent(
    target,
    { type: "compaction_start" },
    onRefreshMessages,
    onRefreshMessagesAndSession,
  );
  assert.equal(target.isCompacting, true);

  await events.handleRpcSessionEvent(
    target,
    { type: "message_end", message: { role: "assistant" } },
    onRefreshMessages,
    onRefreshMessagesAndSession,
  );
  await events.handleRpcSessionEvent(
    target,
    { type: "tool_execution_end", toolCallId: "tool-1" },
    onRefreshMessages,
    onRefreshMessagesAndSession,
  );
  await events.handleRpcSessionEvent(
    target,
    { type: "compaction_message", text: "checkpoint" },
    onRefreshMessages,
    onRefreshMessagesAndSession,
  );
  assert.equal(refreshMessages, 3);
  assert.equal(refreshMessagesAndSession, 0);

  await events.handleRpcSessionEvent(
    target,
    { type: "auto_retry_start", attempt: 3 },
    onRefreshMessages,
    onRefreshMessagesAndSession,
  );
  assert.equal(target.retryAttempt, 3);

  await events.handleRpcSessionEvent(
    target,
    { type: "compaction_end", result: { summary: "done" } },
    onRefreshMessages,
    onRefreshMessagesAndSession,
  );
  assert.equal(target.isCompacting, false);
  assert.equal(refreshMessagesAndSession, 1);

  await events.handleRpcSessionEvent(
    target,
    { type: "auto_retry_end" },
    onRefreshMessages,
    onRefreshMessagesAndSession,
  );
  assert.equal(target.retryAttempt, 0);

  await events.handleRpcSessionEvent(
    target,
    { type: "agent_end" },
    onRefreshMessages,
    onRefreshMessagesAndSession,
  );
  assert.equal(target.isStreaming, false);
  assert.equal(target.remoteTurnRunning, false);
  assert.equal(target.activeTurn, null);
  assert.equal(refreshMessagesAndSession, 2);
  assert.deepEqual(seen, [
    { type: "message_update", message: { role: "assistant" } },
    { type: "agent_start" },
    { type: "compaction_start" },
    { type: "message_end", message: { role: "assistant" } },
    { type: "tool_execution_end", toolCallId: "tool-1" },
    { type: "compaction_message", text: "checkpoint" },
    { type: "auto_retry_start", attempt: 3 },
    { type: "compaction_end", result: { summary: "done" } },
    { type: "auto_retry_end" },
    { type: "agent_end" },
  ]);
});

test("rpc session events fall back to direct streaming flag updates when no remote setter exists", async () => {
  const target = {
    isStreaming: false,
    isCompacting: false,
    retryAttempt: 0,
    activeTurn: { mode: "follow_up" },
    emitEvent() {},
  };

  await events.handleRpcSessionEvent(
    target,
    { type: "agent_start" },
    async () => {},
    async () => {},
  );
  assert.equal(target.isStreaming, true);

  await events.handleRpcSessionEvent(
    target,
    { type: "agent_end" },
    async () => {},
    async () => {},
  );
  assert.equal(target.isStreaming, false);
  assert.equal(target.activeTurn, null);
});
