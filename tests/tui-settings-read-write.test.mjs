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

test("rpc settings hydration applies daemon-provided snapshot without rewriting the file", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-rpc-read-"));
  const initial = {
    quietStartup: true,
    steeringMode: "one-at-a-time",
    followUpMode: "all",
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.4",
  };
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify(initial, null, 2)}\n`,
    "utf8",
  );

  const { createSettingsManager } = await import(
    fileUrl("dist/core/rin-tui/settings-manager.js")
  );
  const { hydrateRpcSettings } = await import(
    fileUrl("dist/core/rin-tui/settings-hydration.js")
  );

  const before = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
  const settingsManager = createSettingsManager();
  hydrateRpcSettings(settingsManager, initial);
  const after = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");

  assert.equal(settingsManager.getQuietStartup(), true);
  assert.equal(settingsManager.getSteeringMode(), "one-at-a-time");
  assert.equal(settingsManager.getFollowUpMode(), "all");
  assert.equal(after, before);
});

test("explicit rpc ui persistence sends settings patch through daemon", async () => {
  const sent = [];
  const { persistRpcSettingsMutation } = await import(
    `${fileUrl("dist/core/rin-tui/model-settings.js")}?t=${Date.now()}`
  );

  await persistRpcSettingsMutation(
    {
      send(payload) {
        sent.push(payload);
        return Promise.resolve({ success: true, data: {} });
      },
    },
    { quietStartup: true, steeringMode: "all" },
  );

  assert.deepEqual(sent, [
    {
      type: "update_settings",
      patch: { quietStartup: true, steeringMode: "all" },
    },
  ]);
});
