import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

function fileUrl(relativePath) {
  return pathToFileURL(path.join(rootDir, relativePath)).href;
}

test("rpc detached bootstrap uses persisted preferences for local ui state", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-detached-ui-"));
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4",
        defaultThinkingLevel: "high",
        steeringMode: "one-at-a-time",
        followUpMode: "all",
        quietStartup: true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const oldRinDir = process.env.RIN_DIR;
  process.env.RIN_DIR = agentDir;

  const { RpcInteractiveSession } = await import(
    `${fileUrl("dist/core/rin-tui/runtime.js")}?t=${Date.now()}`
  );

  const calls = [];
  const client = {
    async connect() {},
    async disconnect() {},
    subscribe() {
      return () => {};
    },
    async send(payload) {
      calls.push(payload.type);
      switch (payload.type) {
        case "get_settings_snapshot":
          return {
            success: true,
            data: {
              settings: {
                defaultProvider: "openai-codex",
                defaultModel: "gpt-5.4",
                defaultThinkingLevel: "high",
                steeringMode: "one-at-a-time",
                followUpMode: "all",
                quietStartup: true,
                compactionEnabled: true,
                transport: "sse",
                theme: "dark",
              },
            },
          };
        case "get_state":
          return {
            success: true,
            data: {
              sessionId: "",
              sessionFile: undefined,
              model: null,
              thinkingLevel: "medium",
              steeringMode: "all",
              followUpMode: "one-at-a-time",
              autoCompactionEnabled: true,
            },
          };
        case "get_messages":
          return { success: true, data: { messages: [] } };
        case "get_session_entries":
          return { success: true, data: { entries: [] } };
        case "get_session_tree":
          return { success: true, data: { tree: [], leafId: null } };
        case "get_available_models":
          return {
            success: true,
            data: {
              models: [
                { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
              ],
            },
          };
        case "get_oauth_state":
          return { success: true, data: {} };
        default:
          throw new Error(`unexpected rpc ${payload.type}`);
      }
    },
  };

  const session = new RpcInteractiveSession(client);
  await session.connect();

  if (oldRinDir === undefined) delete process.env.RIN_DIR;
  else process.env.RIN_DIR = oldRinDir;

  assert.equal(session.detachedBlankSession, true);
  assert.equal(session.settingsManager.getQuietStartup(), true);
  assert.equal(session.steeringMode, "one-at-a-time");
  assert.equal(session.followUpMode, "all");
  assert.equal(session.thinkingLevel, "high");
  assert.equal(session.model?.provider, "openai-codex");
  assert.equal(session.model?.id, "gpt-5.4");
  assert.equal(session.state.thinkingLevel, "high");
  assert.equal(session.state.model?.id, "gpt-5.4");
  assert.deepEqual(calls, [
    "get_settings_snapshot",
    "get_state",
    "get_messages",
    "get_session_entries",
    "get_session_tree",
    "get_available_models",
    "get_oauth_state",
  ]);
});
