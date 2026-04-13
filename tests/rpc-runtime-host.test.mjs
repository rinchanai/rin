import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const { createRpcRuntimeHost } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "runtime-host.js"),
  ).href
);

test("rpc runtime host adapts RpcInteractiveSession shape for InteractiveMode", async () => {
  const calls = [];
  const session = {
    id: "session-like",
    async newSession(options) {
      calls.push(["newSession", options]);
      return true;
    },
    async switchSession(sessionPath, cwdOverride) {
      calls.push(["switchSession", sessionPath, cwdOverride]);
      return false;
    },
    async fork(entryId) {
      calls.push(["fork", entryId]);
      return { cancelled: false, selectedText: "hi" };
    },
    async importFromJsonl(inputPath, cwdOverride) {
      calls.push(["importFromJsonl", inputPath, cwdOverride]);
      return true;
    },
    async disconnect() {
      calls.push(["disconnect"]);
    },
  };

  const runtimeHost = createRpcRuntimeHost(session);

  assert.equal(runtimeHost.session, session);
  assert.deepEqual(await runtimeHost.newSession({ parentSession: "p" }), {
    cancelled: false,
  });
  assert.deepEqual(
    await runtimeHost.switchSession("/tmp/demo.jsonl", "/tmp/cwd"),
    { cancelled: true },
  );
  assert.deepEqual(await runtimeHost.fork("entry-1"), {
    cancelled: false,
    selectedText: "hi",
  });
  assert.deepEqual(
    await runtimeHost.importFromJsonl("/tmp/in.jsonl", "/tmp/cwd"),
    { cancelled: false },
  );
  await runtimeHost.dispose();

  assert.deepEqual(calls, [
    ["newSession", { parentSession: "p" }],
    ["switchSession", "/tmp/demo.jsonl", "/tmp/cwd"],
    ["fork", "entry-1"],
    ["importFromJsonl", "/tmp/in.jsonl", "/tmp/cwd"],
    ["disconnect"],
  ]);
});

test("rpc runtime host dispose tolerates terminateSession failures and still disconnects", async () => {
  const calls = [];
  const session = {
    async disconnect() {
      calls.push(["disconnect"]);
    },
    async terminateSession() {
      calls.push(["terminateSession"]);
      throw new Error("terminate failed");
    },
  };

  const runtimeHost = createRpcRuntimeHost(session);
  await runtimeHost.dispose();

  assert.deepEqual(calls, [["terminateSession"], ["disconnect"]]);
});
