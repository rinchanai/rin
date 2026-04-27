import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);

test("rpc frontend reports Starting during initial TUI startup", () => {
  const client = {
    subscribe() {
      return () => {};
    },
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => false,
    send: async () => ({ success: true, data: {} }),
    submit: async () => {},
    abort: async () => {},
    getAutocompleteItems: async () => [],
    getCommands: async () => [],
    listSessions: async () => [],
    resumeSession: async () => {},
  };
  const session = new RpcInteractiveSession(client);

  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "starting",
    label: "Starting",
    connected: false,
  });
});
