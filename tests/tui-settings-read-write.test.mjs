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

test("rpc settings hydration reads persistent settings without rewriting the file", async () => {
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
  await hydrateRpcSettings(settingsManager, { cwd: rootDir, agentDir });
  const after = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");

  assert.equal(settingsManager.getQuietStartup(), true);
  assert.equal(settingsManager.getSteeringMode(), "one-at-a-time");
  assert.equal(settingsManager.getFollowUpMode(), "all");
  assert.equal(after, before);
});

test("explicit rpc ui persistence writes settings without needing a session", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-rpc-write-"));
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ quietStartup: false }, null, 2)}\n`,
    "utf8",
  );

  const oldRinDir = process.env.RIN_DIR;
  process.env.RIN_DIR = agentDir;
  const stamp = Date.now();
  const { persistRpcSettingsMutation } = await import(
    `${fileUrl("dist/core/rin-tui/model-settings.js")}?t=${stamp}`
  );

  await persistRpcSettingsMutation((settings) => {
    settings.setQuietStartup?.(true);
    settings.setSteeringMode?.("all");
  });

  if (oldRinDir === undefined) delete process.env.RIN_DIR;
  else process.env.RIN_DIR = oldRinDir;

  const saved = JSON.parse(
    fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
  );
  assert.equal(saved.quietStartup, true);
  assert.equal(saved.steeringMode, "all");
});
