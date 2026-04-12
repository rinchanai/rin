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

test("rpc interactive session clears local working state and emits synthetic interrupted tool end plus agent_end when the daemon connection is lost mid-turn", () => {
  const client = { isConnected: () => false };
  const session = new RpcInteractiveSession(client);
  const seen = [];
  session.subscribe((event) => seen.push(event));
  session.isStreaming = true;
  session.activeTurn = { mode: "prompt", message: "hi" };
  session.messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tool-1",
          name: "bash",
          arguments: { command: "rin update" },
        },
      ],
    },
  ];
  session.state.messages = session.messages;
  session.ensureReconnectLoop = () => {};

  session.handleConnectionLost();

  assert.equal(session.isStreaming, false);
  assert.equal(session.activeTurn, null);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.type, "tool_execution_end");
  assert.equal(seen[0]?.toolCallId, "tool-1");
  assert.equal(seen[0]?.toolName, "bash");
  assert.equal(seen[0]?.isError, true);
  assert.equal(
    seen[0]?.result?.content?.[0]?.text,
    "The tool was interrupted by a daemon restart or disconnect.",
  );
  assert.deepEqual(seen[0]?.result?.details, {
    interrupted: true,
    reason: "daemon_restart_or_disconnect",
  });
  assert.equal(seen[1]?.type, "agent_end");
  assert.equal(seen[1]?.interrupted, true);
  assert.equal(seen[1]?.reason, "daemon_restart_or_disconnect");
  assert.equal(seen[1]?.messages, session.messages);
});

test("rpc interactive session does not emit synthetic agent_end when the daemon connection is lost while idle", () => {
  const client = { isConnected: () => false };
  const session = new RpcInteractiveSession(client);
  const seen = [];
  session.subscribe((event) => seen.push(event));
  session.ensureReconnectLoop = () => {};

  session.handleConnectionLost();

  assert.deepEqual(seen, []);
});
