import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const boot = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-koishi", "boot.js"))
    .href
);

test("koishi boot builds allowed command rows with help first", () => {
  const rows = boot.buildAllowedCommandRows([
    { name: "new", description: "new session" },
    { name: "doctor", description: "should be filtered" },
    { name: "model", description: "set model" },
  ]);
  assert.equal(rows[0].name, "help");
  assert.deepEqual(
    rows.map((row) => row.name),
    ["help", "new", "model"],
  );
});

test("koishi boot clears common telegram scopes before syncing default commands", async () => {
  const deletes = [];
  const sets = [];
  const bot = {
    platform: "telegram",
    selfId: "bot-1",
    internal: {
      async deleteMyCommands(payload) {
        deletes.push(payload);
      },
      async setMyCommands(payload) {
        sets.push(payload);
      },
    },
  };

  const rows = boot.buildAllowedCommandRows([
    { name: "new", description: "new session" },
    { name: "model", description: "set model" },
  ]);

  assert.deepEqual(boot.buildTelegramCommandPayload(rows), [
    { command: "help", description: "Show available commands" },
    { command: "new", description: "new session" },
    { command: "model", description: "set model" },
  ]);
  assert.deepEqual(boot.buildTelegramCommandClearScopes(), [
    { type: "all_private_chats" },
    { type: "all_group_chats" },
    { type: "all_chat_administrators" },
  ]);

  await boot.syncTelegramCommands(
    { bots: [bot], $commander: { updateCommands() {} } },
    { warn() {} },
    rows,
  );

  assert.deepEqual(deletes, [
    { scope: { type: "all_private_chats" } },
    { scope: { type: "all_group_chats" } },
    { scope: { type: "all_chat_administrators" } },
  ]);
  assert.deepEqual(sets, [
    {
      commands: [
        { command: "help", description: "Show available commands" },
        { command: "new", description: "new session" },
        { command: "model", description: "set model" },
      ],
    },
  ]);
});
