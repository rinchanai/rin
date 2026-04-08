import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const mod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "model-settings.js"),
  ).href
);

test("tui model settings update detached session state locally", async () => {
  const target = {
    detachedBlankSession: true,
    model: null,
    state: {},
    settingsManager: {
      setDefaultModelAndProvider(provider, id) {
        target.last = `${provider}/${id}`;
      },
      setSteeringMode() {},
      setFollowUpMode() {},
    },
    client: { send: () => Promise.resolve() },
    scopedModels: [],
    thinkingLevel: "medium",
  };
  await mod.setRpcModel(
    target,
    { provider: "openai", id: "gpt-5" },
    async () => {},
  );
  assert.equal(target.last, "openai/gpt-5");
  assert.equal(target.state.model.id, "gpt-5");
  mod.setRpcSteeringMode(target, "one-at-a-time");
  assert.equal(target.steeringMode, "one-at-a-time");
});

test("tui detached session changes stay local and do not emit rpc commands", async () => {
  const sent = [];
  const target = {
    detachedBlankSession: true,
    model: { provider: "openai", id: "gpt-5", reasoning: true },
    state: { model: { provider: "openai", id: "gpt-5", reasoning: true } },
    settingsManager: {
      setDefaultModelAndProvider() {},
      setSteeringMode() {},
      setFollowUpMode() {},
    },
    client: {
      send(payload) {
        sent.push(payload);
        return Promise.resolve();
      },
    },
    scopedModels: [
      { model: { provider: "openai", id: "gpt-5", reasoning: true } },
      {
        model: {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          reasoning: true,
        },
      },
    ],
    thinkingLevel: "medium",
    autoCompactionEnabled: false,
  };

  const result = await mod.cycleRpcModel(
    target,
    "forward",
    () => target.scopedModels.map((entry) => entry.model),
    async () => {},
  );
  mod.setRpcThinkingLevel(target, "high");
  mod.setRpcSteeringMode(target, "one-at-a-time");
  mod.setRpcFollowUpMode(target, "all");
  mod.setRpcAutoCompaction(target, true);

  assert.equal(result.model.provider, "anthropic");
  assert.equal(target.state.model.provider, "anthropic");
  assert.equal(target.thinkingLevel, "high");
  assert.equal(target.steeringMode, "one-at-a-time");
  assert.equal(target.followUpMode, "all");
  assert.equal(target.autoCompactionEnabled, true);
  assert.deepEqual(sent, []);
});
