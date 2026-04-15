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

test("rpc interactive session treats connected recovery as starting instead of connecting", () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = true;
  session.startupPending = false;
  session.recoveryPending = true;

  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "starting",
    label: "Starting",
    connected: true,
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
