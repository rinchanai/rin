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

test("rpc runtime keeps control methods bound to the session instance", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.detachedBlankSession = true;
  const model = { provider: "test", id: "demo-model" };
  const {
    setModel,
    setSteeringMode,
    setFollowUpMode,
    setAutoCompactionEnabled,
  } = session;

  await setModel(model);
  setSteeringMode("one-at-a-time");
  setFollowUpMode("all");
  setAutoCompactionEnabled(true);

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.model, model);
  assert.deepEqual(session.state.model, model);
  assert.equal(session.steeringMode, "one-at-a-time");
  assert.equal(session.followUpMode, "all");
  assert.equal(session.settingsManager.getSteeringMode(), "one-at-a-time");
  assert.equal(session.settingsManager.getFollowUpMode(), "all");
  assert.deepEqual(
    sent.map((entry) => entry.type),
    ["set_steering_mode", "set_follow_up_mode", "set_auto_compaction"],
  );
});
