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
    model: null,
    thinkingLevel: "medium",
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    autoCompactionEnabled: false,
    sessionId: "",
    sessionFile: undefined,
    sessionName: undefined,
    detachedBlankSession: true,
    state: {},
    settingsManager: { setSteeringMode() {}, setFollowUpMode() {} },
  };
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
  assert.equal(target.detachedBlankSession, false);

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

test("rpc reconnect helper queues and emits status", () => {
  const events = [];
  const target = {
    queuedOfflineOps: [],
    emitEvent: (e) => events.push(e),
    ensureReconnectLoop: () => events.push({ reconnect: true }),
  };
  reconnect.queueOfflineOperation(target, { mode: "prompt", message: "hi" });
  assert.equal(target.queuedOfflineOps.length, 1);
  assert.equal(events.length, 2);
});
