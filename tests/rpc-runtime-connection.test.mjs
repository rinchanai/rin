import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const runtimeConnection = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "runtime-connection.js"),
  ).href
);

function createConnectionSession(overrides = {}) {
  const events = [];
  const calls = [];
  const queued = [];
  const sent = [];
  let connected = Boolean(overrides.connected);
  let connectFailures = overrides.connectFailures ?? 0;

  const session = {
    client: {
      isConnected: () => connected,
      connect: async () => {
        calls.push(["client.connect"]);
        if (connectFailures > 0) {
          connectFailures -= 1;
          throw new Error("connect failed");
        }
        connected = true;
      },
    },
    call: async (type, payload = {}) => {
      sent.push([type, payload]);
      if (overrides.callImpl) {
        return await overrides.callImpl(type, payload, { sent, session });
      }
      return {};
    },
    refreshState: async (flags) => {
      calls.push(["refreshState", flags]);
    },
    queueRefreshState: async (flags) => {
      calls.push(["queueRefreshState", flags]);
    },
    ensureRemoteSession: async () => {
      calls.push(["ensureRemoteSession"]);
    },
    ensureReconnectLoop: () => {
      calls.push(["ensureReconnectLoop"]);
    },
    sendOrQueue: async (operation) => {
      queued.push(operation);
    },
    syncStreamingState: () => {
      calls.push(["syncStreamingState"]);
    },
    setRpcConnected: (value) => {
      calls.push(["setRpcConnected", value]);
      session.rpcConnected = value;
    },
    emitEvent: (event) => {
      events.push(event);
    },
    clearWaitingDaemonState: () => {
      calls.push(["clearWaitingDaemonState"]);
      if (session.waitForDaemonHintTimer) {
        clearTimeout(session.waitForDaemonHintTimer);
        session.waitForDaemonHintTimer = null;
      }
      session.waitForDaemonPromise = null;
    },
    messages: overrides.messages ?? [],
    queuedOfflineOps: overrides.queuedOfflineOps ?? [],
    activeTurn: overrides.activeTurn ?? null,
    remoteTurnRunning: overrides.remoteTurnRunning ?? false,
    isStreaming: overrides.isStreaming ?? false,
    disposed: overrides.disposed ?? false,
    reconnecting: overrides.reconnecting ?? false,
    reconnectTimer: overrides.reconnectTimer ?? null,
    restorePromise: null,
    waitForDaemonPromise: null,
    waitForDaemonHintTimer: null,
    sessionFile: overrides.sessionFile,
    sessionId: overrides.sessionId,
    rpcConnected: false,
    ...overrides,
  };

  return {
    session,
    events,
    calls,
    queued,
    sent,
    setConnected: (value) => {
      connected = value;
    },
  };
}

test("runtime connection waits once for the daemon and clears wait state after reconnect", async () => {
  const harness = createConnectionSession({ connected: false });
  const { session, events, calls } = harness;

  const first = runtimeConnection.waitForDaemonAvailable(session);
  const second = runtimeConnection.waitForDaemonAvailable(session);
  await Promise.all([first, second]);

  assert.equal(events[0]?.type, "status");
  assert.match(events[0]?.text || "", /Waiting daemon/);
  assert.ok(calls.filter(([name]) => name === "client.connect").length >= 1);
  assert.equal(session.waitForDaemonPromise, null);
  assert.equal(session.waitForDaemonHintTimer, null);
  assert.ok(calls.some(([name]) => name === "clearWaitingDaemonState"));
});

test("runtime connection queues offline operations when disconnected", async () => {
  const harness = createConnectionSession({ connected: false });
  const { session } = harness;
  const operation = {
    mode: "prompt",
    message: "hello",
    source: "user",
    requestTag: "tag-1",
  };

  await runtimeConnection.sendOrQueueOperation(session, operation, {
    messages: true,
    models: true,
    session: true,
  });

  assert.deepEqual(session.queuedOfflineOps, [operation]);
});

test("runtime connection retries a queued turn after reattaching the active session", async () => {
  const harness = createConnectionSession({
    connected: true,
    sessionFile: "/tmp/current.jsonl",
    callImpl: async (type, payload, { sent }) => {
      if (
        type === "prompt" &&
        !sent.some(([entry]) => entry === "switch_session")
      ) {
        throw new Error("rin_no_attached_session");
      }
      return { ok: true, payload };
    },
  });
  const { session, sent, calls } = harness;
  const operation = {
    mode: "prompt",
    message: "resume work",
    source: "rpc",
    requestTag: "tag-retry",
  };

  await runtimeConnection.sendOrQueueOperation(session, operation, {
    messages: true,
    models: true,
    session: true,
  });

  assert.deepEqual(sent, [
    [
      "prompt",
      {
        message: "resume work",
        images: undefined,
        source: "rpc",
        requestTag: "tag-retry",
      },
    ],
    ["switch_session", { sessionPath: "/tmp/current.jsonl" }],
    [
      "prompt",
      {
        message: "resume work",
        images: undefined,
        source: "rpc",
        requestTag: "tag-retry",
      },
    ],
  ]);
  assert.ok(
    calls.some(
      ([name, flags]) =>
        name === "refreshState" &&
        flags?.messages === true &&
        flags?.models === true &&
        flags?.session === true,
    ),
  );
  assert.equal(session.activeTurn, operation);
});

test("runtime connection lost emits interrupted tool completions and an interrupted agent end", () => {
  const harness = createConnectionSession({
    isStreaming: true,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "bash",
            arguments: { command: "sleep 1" },
          },
          {
            type: "toolCall",
            id: "tool-2",
            name: "fetch",
            arguments: { url: "https://example.com" },
          },
        ],
      },
    ],
  });
  const { session, events, calls } = harness;

  runtimeConnection.handleRuntimeConnectionLost(session);

  assert.deepEqual(calls.slice(0, 1), [["setRpcConnected", false]]);
  assert.equal(
    events.filter((event) => event.type === "tool_execution_end").length,
    2,
  );
  assert.equal(
    events.find((event) => event.type === "agent_end")?.interrupted,
    true,
  );
  assert.equal(
    events.find((event) => event.type === "agent_end")?.reason,
    "daemon_restart_or_disconnect",
  );
  assert.ok(calls.some(([name]) => name === "ensureReconnectLoop"));
});

test("runtime connection restore reattaches the session and replays queued operations", async () => {
  const operationA = {
    mode: "prompt",
    message: "first",
    source: "user",
    requestTag: "tag-a",
  };
  const operationB = {
    mode: "follow_up",
    message: "second",
    source: "user",
    requestTag: "tag-b",
  };
  const harness = createConnectionSession({
    connected: true,
    sessionFile: "/tmp/current.jsonl",
    queuedOfflineOps: [operationA, operationB],
  });
  const { session, calls, queued, sent } = harness;

  await runtimeConnection.handleRuntimeConnectionRestored(
    session,
    { session: true },
    { messages: true, session: true },
  );

  assert.deepEqual(sent[0], [
    "switch_session",
    { sessionPath: "/tmp/current.jsonl" },
  ]);
  assert.ok(
    calls.some(([name, value]) => name === "setRpcConnected" && value === true),
  );
  assert.ok(
    calls.some(
      ([name, flags]) => name === "refreshState" && flags?.session === true,
    ),
  );
  assert.ok(
    calls.some(
      ([name, flags]) =>
        name === "queueRefreshState" &&
        flags?.messages === true &&
        flags?.session === true,
    ),
  );
  assert.deepEqual(queued, [operationA, operationB]);
  assert.deepEqual(session.queuedOfflineOps, []);
  assert.equal(session.restorePromise, null);
  assert.equal(session.reconnecting, false);
});

test("runtime connection restore attaches by session id when no session file is present", async () => {
  const harness = createConnectionSession({
    connected: true,
    sessionId: "session-123",
  });
  const { session, sent } = harness;

  await runtimeConnection.handleRuntimeConnectionRestored(
    session,
    { session: true },
    { messages: true, session: true },
  );

  assert.deepEqual(sent[0], ["attach_session", { sessionId: "session-123" }]);
});
