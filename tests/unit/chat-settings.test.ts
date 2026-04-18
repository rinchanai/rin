import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const chatSettings = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "settings.js"))
    .href,
);
const support = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js"))
    .href,
);

test("chat settings normalization migrates legacy koishi config into chat", () => {
  const sourceLegacy = { telegram: { token: "legacy-token" } };
  const settings = { koishi: sourceLegacy };

  const normalized = chatSettings.normalizeStoredChatSettings(settings);
  normalized.chat.telegram.token = "updated-token";

  assert.equal(normalized, settings);
  assert.deepEqual(normalized.chat, { telegram: { token: "updated-token" } });
  assert.equal("koishi" in normalized, false);
  assert.deepEqual(sourceLegacy, { telegram: { token: "legacy-token" } });
});

test("chat settings normalization can force a writable chat object", () => {
  const normalized = chatSettings.normalizeStoredChatSettings(
    { chat: "broken" },
    { ensureChat: true },
  );

  assert.deepEqual(normalized, { chat: {} });
});

test("chat settings helper can drop legacy koishi settings without creating chat", () => {
  const normalized = chatSettings.dropLegacyChatSettings({
    koishi: { telegram: { token: "legacy-token" } },
    keep: true,
  });

  assert.deepEqual(normalized, { keep: true });
});

test("chat support still materializes legacy koishi adapter settings", () => {
  const config = support.buildChatConfigFromSettings({
    koishi: {
      telegram: { token: "legacy-token" },
    },
  });

  assert.deepEqual(config.plugins["adapter-telegram"], {
    protocol: "polling",
    token: "legacy-token",
    slash: true,
  });
});
