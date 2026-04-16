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
  const model = { provider: "test", id: "demo-model", name: "Demo Model" };
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      switch (payload.type) {
        case "set_model":
          return Promise.resolve({ success: true, data: {} });
        case "get_state":
          return Promise.resolve({
            success: true,
            data: {
              sessionId: "s1",
              sessionFile: "/tmp/s1.jsonl",
              model,
              thinkingLevel: "medium",
              steeringMode: "all",
              followUpMode: "one-at-a-time",
              autoCompactionEnabled: false,
            },
          });
        case "get_available_models":
          return Promise.resolve({ success: true, data: { models: [model] } });
        case "get_oauth_state":
          return Promise.resolve({ success: true, data: {} });
        default:
          return Promise.resolve({ success: true, data: {} });
      }
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

  session.sessionId = "s1";
  session.sessionFile = "/tmp/s1.jsonl";
  session.settingsManager = {
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    setSteeringMode(mode) {
      this.steeringMode = mode;
    },
    getSteeringMode() {
      return this.steeringMode;
    },
    setFollowUpMode(mode) {
      this.followUpMode = mode;
    },
    getFollowUpMode() {
      return this.followUpMode;
    },
  };

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
    [
      "set_model",
      "get_state",
      "get_available_models",
      "get_oauth_state",
      "set_steering_mode",
      "set_follow_up_mode",
      "set_auto_compaction",
    ],
  );
});

test("rpc runtime executes local extension commands immediately through prompt", async () => {
  const session = new RpcInteractiveSession({
    send() {
      throw new Error("should_not_send_remote_prompt");
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

  const calls = [];
  session.extensionRunner = {
    getCommand(name) {
      return name === "chat"
        ? {
            invocationName: "chat",
            handler: async (args, ctx) => {
              calls.push(["handler", args, Boolean(ctx)]);
            },
          }
        : undefined;
    },
    createCommandContext() {
      return { ui: {}, waitForIdle: async () => {} };
    },
    emitError(error) {
      calls.push(["error", error.error]);
    },
  };

  await session.prompt("/chat telegram", { streamingBehavior: "steer" });

  assert.deepEqual(calls, [["handler", "telegram", true]]);
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.pendingMessageCount, 0);
});

test("rpc runtime forwards prompt streamingBehavior through prompt mode", async () => {
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

  session.sessionId = "s1";
  await session.prompt("hello", { streamingBehavior: "steer" });

  assert.equal(sent.length, 1);
  assert.deepEqual(
    {
      ...sent[0],
      requestTag: typeof sent[0]?.requestTag === "string" ? "<auto>" : sent[0]?.requestTag,
    },
    {
      type: "prompt",
      sessionId: "s1",
      message: "hello",
      images: undefined,
      streamingBehavior: "steer",
      source: undefined,
      requestTag: "<auto>",
    },
  );
  assert.deepEqual(session.getSteeringMessages(), ["hello"]);
  assert.equal(session.pendingMessageCount, 1);
});

