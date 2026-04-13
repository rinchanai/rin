import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const stateUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "state-utils.js"))
    .href
);
const reconnect = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "reconnect.js"))
    .href
);

test("rpc state utils derive branch and apply state", () => {
  const target = {
    model: { provider: "openai", id: "gpt-5" },
    thinkingLevel: "high",
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    autoCompactionEnabled: false,
    sessionId: "",
    sessionFile: undefined,
    sessionName: undefined,
    state: {},
    settingsManager: { setSteeringMode() {}, setFollowUpMode() {} },
  };

  stateUtils.applyRpcSessionState(target, {
    sessionId: "",
    sessionFile: undefined,
    thinkingLevel: "medium",
    steeringMode: "one-at-a-time",
    followUpMode: "all",
    isStreaming: false,
  });
  assert.equal(target.model, null);
  assert.equal(target.thinkingLevel, "medium");
  assert.equal(target.steeringMode, "one-at-a-time");
  assert.equal(target.followUpMode, "all");

  stateUtils.applyRpcSessionState(target, {
    sessionId: "s1",
    sessionFile: "/tmp/x",
    thinkingLevel: "low",
    isStreaming: true,
  });
  assert.equal(target.sessionId, "s1");
  assert.equal(target.sessionFile, "/tmp/x");
  assert.equal(target.thinkingLevel, "low");
  assert.equal(target.isStreaming, true);

  let remoteStreaming = false;
  stateUtils.applyRpcSessionState(
    {
      ...target,
      setRemoteTurnRunning(value) {
        remoteStreaming = value;
      },
    },
    {
      sessionId: "s2",
      sessionFile: "/tmp/y",
      isStreaming: true,
    },
  );
  assert.equal(remoteStreaming, true);

  const entryById = new Map([
    ["1", { id: "1" }],
    ["2", { id: "2", parentId: "1" }],
  ]);
  const branch = stateUtils.getSessionBranch(entryById, "2");
  assert.deepEqual(
    branch.map((x) => x.id),
    ["1", "2"],
  );
});

test("rpc reconnect helper queues offline operations and starts reconnect attempts", () => {
  const events = [];
  const target = {
    queuedOfflineOps: [],
    ensureReconnectLoop: () => events.push({ reconnect: true }),
  };
  reconnect.queueOfflineOperation(target, { mode: "prompt", message: "hi" });
  reconnect.queueOfflineOperation(target, {
    mode: "follow_up",
    message: "next",
  });
  assert.deepEqual(target.queuedOfflineOps, [
    { mode: "prompt", message: "hi" },
    { mode: "follow_up", message: "next" },
  ]);
  assert.deepEqual(events, [{ reconnect: true }, { reconnect: true }]);
});

test("rpc reconnect helper skips reconnect work after disposal", () => {
  let reconnects = 0;
  reconnect.emitConnectionLost({
    disposed: true,
    ensureReconnectLoop: () => {
      reconnects += 1;
    },
  });
  reconnect.emitConnectionLost({
    disposed: false,
    ensureReconnectLoop: () => {
      reconnects += 1;
    },
  });
  assert.equal(reconnects, 1);
});
