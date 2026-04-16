import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const { RinDaemonFrontendClient } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "rpc-client.js"))
    .href
);
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);

test("rpc client ignores stale socket disconnect after reconnect", () => {
  const client = new RinDaemonFrontendClient("/tmp/fake.sock");
  const seen = [];
  client.subscribe((event) => seen.push(event));

  const staleSocket = { destroyed: false };
  const currentSocket = { destroyed: false };

  client.socket = currentSocket;
  client.connectPromise = null;

  RinDaemonFrontendClient.prototype.handleDisconnect.call(
    client,
    true,
    staleSocket,
  );

  assert.equal(client.socket, currentSocket);
  assert.equal(seen.length, 0);

  RinDaemonFrontendClient.prototype.handleDisconnect.call(
    client,
    true,
    currentSocket,
  );

  assert.equal(client.socket, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.type, "ui");
  assert.equal(seen[0]?.name, "connection_lost");
});

test("rpc interactive session startup fails when the daemon is unavailable", async () => {
  const client = {
    isConnected: () => false,
    connect: async () => {
      throw new Error("daemon_down");
    },
    subscribe: () => () => {},
    disconnect: async () => {},
  };
  const session = new RpcInteractiveSession(client);
  session.ensureReconnectLoop = async () => {};

  await assert.rejects(session.connect(), /daemon_down/);
  assert.equal(session.rpcConnected, false);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: false,
  });
});

test("rpc interactive session switches to connecting state instead of emitting a fake turn end on disconnect", () => {
  const client = { isConnected: () => false };
  const session = new RpcInteractiveSession(client);
  const seen = [];
  session.subscribe((event) => seen.push(event));
  session.ensureReconnectLoop = () => {};
  session.recoveryPending = false;
  session.rpcConnected = true;
  session.activeTurn = { mode: "prompt", message: "hi" };
  session.syncStreamingState();
  seen.length = 0;

  session.handleConnectionLost();

  assert.equal(session.isStreaming, false);
  assert.equal(session.activeTurn, null);
  assert.deepEqual(seen, [
    {
      type: "rpc_frontend_status",
      phase: "connecting",
      label: "Connecting",
      connected: false,
    },
  ]);
});

test("rpc interactive session replays the current frontend status to new subscribers", () => {
  const client = { isConnected: () => false };
  const session = new RpcInteractiveSession(client);
  session.sessionOperationPending = true;
  session.rpcConnected = true;

  const seen = [];
  session.subscribe((event) => seen.push(event));

  assert.deepEqual(seen, [
    {
      type: "rpc_frontend_status",
      phase: "starting",
      label: "Starting",
      connected: true,
    },
  ]);
});

test("rpc interactive session stays in connecting until session recovery succeeds", async () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  session.sessionFile = "/tmp/demo.jsonl";
  session.startupPending = false;
  session.recoveryPending = true;
  session.rpcConnected = false;
  session.call = async () => {
    throw new Error("rin_timeout:select_session");
  };
  session.refreshState = async () => {};

  await assert.rejects(
    session.handleConnectionRestored(),
    /rin_timeout:select_session/,
  );

  assert.equal(session.rpcConnected, false);
  assert.equal(session.recoveryPending, true);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: false,
  });
});

test("rpc interactive session keeps working status during compaction", () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = true;
  session.startupPending = false;
  session.isCompacting = true;

  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "working",
    label: "Working",
    connected: true,
  });
});

test("rpc interactive session reconnect loop restores transport and session in one pipeline", async () => {
  let connected = false;
  let connectCalls = 0;
  let restoreCalls = 0;
  const client = {
    isConnected: () => connected,
    connect: async () => {
      connectCalls += 1;
      connected = true;
    },
  };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = false;
  session.recoveryPending = true;
  session.handleConnectionRestored = async () => {
    restoreCalls += 1;
    session.rpcConnected = true;
    session.recoveryPending = false;
  };

  await session.ensureReconnectLoop();

  assert.equal(connectCalls, 1);
  assert.equal(restoreCalls, 1);
  assert.equal(session.reconnecting, false);
});

test("rpc interactive session waitForDaemonAvailable reuses the reconnect pipeline", async () => {
  const client = { isConnected: () => false };
  const session = new RpcInteractiveSession(client);
  let reconnects = 0;
  session.ensureReconnectLoop = async () => {
    reconnects += 1;
  };

  await session.waitForDaemonAvailable();

  assert.equal(reconnects, 1);
});

test("rpc interactive session keeps the daemon connection while a worker exits mid-turn", () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  session.ensureReconnectLoop = () => {};
  session.rpcConnected = true;
  session.startupPending = false;
  session.activeTurn = {
    mode: "prompt",
    message: "search memory",
    requestTag: "tag-1",
  };
  session.setRemoteTurnRunning(true);

  const seen = [];
  session.subscribe((event) => seen.push(event));
  seen.length = 0;

  session.handleRpcEvent({ type: "worker_exit", code: 9, signal: null });

  assert.equal(session.activeTurn, null);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: true,
  });
  assert.deepEqual(seen, [
    {
      type: "rpc_frontend_status",
      phase: "connecting",
      label: "Connecting",
      connected: true,
    },
    { type: "worker_exit", code: 9, signal: null },
  ]);
});

test("rpc interactive session attaches a request tag to prompt turns by default", async () => {
  const calls = [];
  const client = {
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      return { success: true, data: {} };
    },
  };
  const session = new RpcInteractiveSession(client);
  session.ensureRemoteSession = async () => {};
  session.rpcConnected = true;

  await session.prompt("hello", { expandPromptTemplates: false });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.type, "prompt");
  assert.match(String(calls[0]?.requestTag || ""), /^rin-tui-/);
});

test("rpc interactive session can terminate an attached worker without local session selectors", async () => {
  const calls = [];
  const client = {
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      return { success: true, data: { terminated: true } };
    },
  };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = true;

  await session.terminateSession();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.type, "terminate_session");
});

test("rpc interactive session queues prompts while recovery is pending", async () => {
  const calls = [];
  const session = new RpcInteractiveSession({
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      return { success: true, data: {} };
    },
  });
  session.ensureReconnectLoop = () => Promise.resolve();
  session.startupPending = false;
  session.recoveryPending = true;
  session.rpcConnected = true;

  await session.prompt("hello", { expandPromptTemplates: false });

  assert.equal(calls.length, 0);
  assert.deepEqual(session.queuedOfflineOps, [
    {
      mode: "prompt",
      message: "hello",
      images: undefined,
      streamingBehavior: undefined,
      source: undefined,
      requestTag: session.queuedOfflineOps[0]?.requestTag,
    },
  ]);
  assert.match(String(session.queuedOfflineOps[0]?.requestTag || ""), /^rin-tui-/);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: true,
  });
});

test("rpc interactive session finishes daemon-side session recovery without dropping transport", async () => {
  const calls = [];
  const session = new RpcInteractiveSession({
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      switch (payload.type) {
        case "get_state":
          return {
            success: true,
            data: {
              sessionId: "s1",
              sessionFile: "/tmp/s1.jsonl",
              thinkingLevel: "medium",
              steeringMode: "all",
              followUpMode: "one-at-a-time",
              autoCompactionEnabled: false,
              isStreaming: false,
              isCompacting: false,
              pendingMessageCount: 0,
            },
          };
        case "get_messages":
          return { success: true, data: { messages: [] } };
        case "get_session_entries":
          return { success: true, data: { entries: [] } };
        case "get_session_tree":
          return { success: true, data: { tree: [], leafId: null } };
        default:
          return { success: true, data: {} };
      }
    },
  });
  session.rpcConnected = true;
  session.startupPending = false;
  session.recoveryPending = true;
  session.queuedOfflineOps = [
    {
      mode: "prompt",
      message: "hello",
      requestTag: "tag-1",
    },
  ];

  session.handleSessionRecovered();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(session.recoveryPending, false);
  assert.equal(session.queuedOfflineOps.length, 0);
  assert.deepEqual(calls.map((payload) => payload.type), [
    "get_state",
    "get_messages",
    "get_session_entries",
    "get_session_tree",
    "prompt",
  ]);
});

test("rpc interactive session clears the busy state immediately when abort is requested", async () => {
  let abortResolved = false;
  let resolveAbort;
  const client = {
    abort: () =>
      new Promise((resolve) => {
        resolveAbort = () => {
          abortResolved = true;
          resolve();
        };
      }),
  };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = true;
  session.startupPending = false;
  session.activeTurn = {
    mode: "prompt",
    message: "hello",
    requestTag: "tag-1",
  };
  session.remoteTurnRunning = true;
  session.isCompacting = true;
  session.isBashRunning = true;
  session.retryAttempt = 2;
  session.syncStreamingState();

  const seen = [];
  session.subscribe((event) => seen.push(event));
  seen.length = 0;

  await session.abort();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.activeTurn, null);
  assert.equal(session.remoteTurnRunning, false);
  assert.equal(session.isCompacting, false);
  assert.equal(session.isBashRunning, false);
  assert.equal(session.retryAttempt, 0);
  assert.equal(session.isStreaming, false);
  assert.equal(session.getFrontendStatusEvent(), null);
  assert.equal(abortResolved, false);
  assert.deepEqual(seen, [{ type: "rpc_frontend_status", phase: "idle" }]);

  resolveAbort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(abortResolved, true);
});
