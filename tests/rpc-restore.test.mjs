import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);

test("rpc restore resumes once and avoids full model refresh churn", async () => {
  const events = [];
  const calls = [];
  const refreshes = [];
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });

  const target = {
    disposed: false,
    restorePromise: null,
    reconnecting: true,
    reconnectTimer: null,
    emitEvent: (event) => events.push(event),
    sessionFile: "/tmp/demo.jsonl",
    sessionId: "",
    call: async (type, payload) => {
      calls.push({ type, payload });
      return {};
    },
    resumeInterruptedTurn: async (options) => {
      calls.push({ type: "resume_interrupted_turn", payload: options });
    },
    refreshState: async (flags) => {
      refreshes.push(flags);
      await refreshGate;
    },
    activeTurn: { mode: "prompt", message: "hi" },
    restoreResumeSent: false,
    queuedOfflineOps: [],
    sendOrQueue: async () => {
      throw new Error("should_not_send_queued_ops");
    },
    isStreaming: false,
    isCompacting: false,
  };

  const p1 =
    RpcInteractiveSession.prototype.handleConnectionRestored.call(target);
  const p2 =
    RpcInteractiveSession.prototype.handleConnectionRestored.call(target);
  releaseRefresh();
  await Promise.all([p1, p2]);

  assert.equal(
    calls.filter((item) => item.type === "switch_session").length,
    1,
  );
  assert.equal(
    calls.filter((item) => item.type === "resume_interrupted_turn").length,
    1,
  );
  assert.deepEqual(refreshes, [{ messages: true, session: true }]);
  assert.ok(events.some((event) => event?.type === "rin_status"));
});

test("rpc refreshState ignores unattached empty state while a session is expected", async () => {
  const target = {
    sessionFile: "/tmp/demo.jsonl",
    sessionId: "",
    pendingMessageCount: 2,
    lastSessionStats: undefined,
    modelRegistry: {
      sync: async () => {
        throw new Error("should_not_sync_models");
      },
    },
    call: async (type) => {
      assert.equal(type, "get_state");
      return {
        sessionFile: undefined,
        sessionId: "",
        pendingMessageCount: 0,
      };
    },
    applyState: () => {
      throw new Error("should_not_apply_empty_state");
    },
    refreshMessages: async () => {
      throw new Error("should_not_refresh_messages");
    },
    refreshSessionData: async () => {
      throw new Error("should_not_refresh_session");
    },
    reconcilePendingQueues(count) {
      this.seenPendingCount = count;
    },
    computeSessionStats() {
      return { ok: true };
    },
  };

  await RpcInteractiveSession.prototype.refreshState.call(target, {
    messages: true,
    session: true,
    models: true,
  });

  assert.equal(target.seenPendingCount, undefined);
  assert.equal(target.lastSessionStats, undefined);
});
