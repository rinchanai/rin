import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
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
    { name: "abort", description: "abort" },
    { name: "new", description: "new session" },
    { name: "doctor", description: "should be filtered" },
    { name: "model", description: "set model" },
  ]);
  assert.equal(rows[0].name, "help");
  assert.deepEqual(
    rows.map((row) => row.name),
    ["help", "abort", "new", "model"],
  );
});

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-koishi-boot-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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
    { name: "abort", description: "abort" },
    { name: "new", description: "new session" },
    { name: "model", description: "set model" },
  ]);

  assert.deepEqual(boot.buildTelegramCommandPayload(rows), [
    { command: "help", description: "Show available commands" },
    { command: "abort", description: "abort" },
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
        { command: "abort", description: "abort" },
        { command: "new", description: "new session" },
        { command: "model", description: "set model" },
      ],
    },
  ]);
});

test("koishi boot claims outbox files before sending so concurrent drains do not duplicate delivery", async () => {
  await withTempDir(async (agentDir) => {
    const outboxDir = path.join(agentDir, "data", "chat-outbox");
    await fs.mkdir(outboxDir, { recursive: true });
    await fs.writeFile(
      path.join(outboxDir, "one.json"),
      JSON.stringify({
        type: "text_delivery",
        chatKey: "telegram/1:2",
        text: "hello",
      }),
    );

    const sends = [];
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          async sendMessage(chatId, content) {
            sends.push({ chatId, content });
            await new Promise((resolve) => setTimeout(resolve, 50));
            return ["m1"];
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      quote(id) {
        return { type: "quote", attrs: { id } };
      },
    };

    await Promise.all([
      boot.drainKoishiOutbox(app, agentDir, h, { warn() {} }),
      boot.drainKoishiOutbox(app, agentDir, h, { warn() {} }),
    ]);

    assert.equal(sends.length, 1);
  });
});
