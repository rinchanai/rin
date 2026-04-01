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
