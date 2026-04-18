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
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-message-store-"),
  );
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function chatDateIndexPath(root, date) {
  return path.join(
    root,
    "data",
    "chat-message-store",
    "indexes",
    "by-chat-date",
    "telegram",
    "123",
    "456",
    `${date}.json`,
  );
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

test("message store eagerly maintains chat-date indexes while preserving chat-day reads", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(root, {
      messageId: "m1",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:00.000Z",
      text: "first",
      rawContent: "first",
      strippedContent: "first",
    });
    messageStore.saveChatMessage(root, {
      messageId: "m2",
      role: "assistant",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:05.000Z",
      text: "second",
      rawContent: "second",
      strippedContent: "second",
    });
    messageStore.saveChatMessage(root, {
      messageId: "other",
      role: "user",
      chatKey: "telegram/123:789",
      platform: "telegram",
      botId: "123",
      chatId: "789",
      chatType: "private",
      receivedAt: "2026-04-04T08:00:00.000Z",
      text: "noise",
      rawContent: "noise",
      strippedContent: "noise",
    });

    const indexPath = chatDateIndexPath(root, "2026-04-04");
    assert.deepEqual(await readJson(indexPath), {
      version: 1,
      recordKeys: [
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m1"),
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m2"),
      ],
    });

    messageStore.saveChatMessage(root, {
      messageId: "m3",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:10.000Z",
      text: "third",
      rawContent: "third",
      strippedContent: "third",
    });

    assert.deepEqual(await readJson(indexPath), {
      version: 1,
      recordKeys: [
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m1"),
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m2"),
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m3"),
      ],
    });
    assert.deepEqual(
      messageStore
        .listChatMessagesByChatAndDate(root, "telegram/123:456", "2026-04-04")
        .map((item) => item.messageId),
      ["m1", "m2", "m3"],
    );
  });
});

test("message store backfills a missing chat-date index from existing records", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(root, {
      messageId: "m1",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:00.000Z",
      text: "first",
      rawContent: "first",
      strippedContent: "first",
    });
    messageStore.saveChatMessage(root, {
      messageId: "m2",
      role: "assistant",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:05.000Z",
      text: "second",
      rawContent: "second",
      strippedContent: "second",
    });

    const indexPath = chatDateIndexPath(root, "2026-04-04");
    await fs.rm(indexPath, { force: true });
    await assert.rejects(fs.access(indexPath));

    const rebuilt = messageStore.listChatMessagesByChatAndDate(
      root,
      "telegram/123:456",
      "2026-04-04",
    );
    assert.deepEqual(
      rebuilt.map((item) => item.messageId),
      ["m1", "m2"],
    );
    assert.deepEqual(await readJson(indexPath), {
      version: 1,
      recordKeys: [
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m1"),
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m2"),
      ],
    });
  });
});

test("message store removes stale chat-date index entries when indexed records move to another day", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(root, {
      messageId: "m1",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:00.000Z",
      text: "first",
      rawContent: "first",
      strippedContent: "first",
    });

    assert.equal(
      messageStore.listChatMessagesByChatAndDate(
        root,
        "telegram/123:456",
        "2026-04-04",
      ).length,
      1,
    );

    messageStore.updateChatMessage(root, "telegram/123:456", "m1", {
      receivedAt: "2026-04-05T09:30:00.000Z",
    });

    const dayOneIndex = await readJson(chatDateIndexPath(root, "2026-04-04"));
    assert.deepEqual(dayOneIndex, { version: 1, recordKeys: [] });
    assert.equal(
      messageStore.listChatMessagesByChatAndDate(
        root,
        "telegram/123:456",
        "2026-04-04",
      ).length,
      0,
    );

    const nextDay = messageStore.listChatMessagesByChatAndDate(
      root,
      "telegram/123:456",
      "2026-04-05",
    );
    assert.deepEqual(
      nextDay.map((item) => item.messageId),
      ["m1"],
    );
    assert.deepEqual(await readJson(chatDateIndexPath(root, "2026-04-05")), {
      version: 1,
      recordKeys: [
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m1"),
      ],
    });
  });
});
