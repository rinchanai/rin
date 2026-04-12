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
const chatLog = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-koishi", "chat-log.js"))
    .href
);
const messageStore = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-koishi", "message-store.js"),
  ).href
);

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-koishi-chat-log-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("koishi chat log appends into unified message store and reads one day chat history", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveKoishiMessage(root, {
      messageId: "m1",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:00.000Z",
      nickname: "Alice",
      trust: "OWNER",
      chatName: "Demo Chat",
      text: "Good morning",
      rawContent: "Good morning",
      strippedContent: "Good morning",
    });
    chatLog.appendKoishiChatLog(root, {
      timestamp: "2026-04-04T12:00:00.000Z",
      chatKey: "telegram/123:456",
      role: "user",
      text: "Good morning",
      messageId: "m1",
      nickname: "Alice",
    });
    messageStore.saveKoishiMessage(root, {
      messageId: "m2",
      role: "assistant",
      replyToMessageId: "m1",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:05.000Z",
      text: "Good morning!",
      rawContent: "Good morning!",
      strippedContent: "Good morning!",
    });

    const stored = messageStore.getKoishiMessage(
      root,
      "telegram/123:456",
      "m1",
    );
    assert.equal(stored?.role, "user");
    assert.equal(stored?.nickname, "Alice");
    assert.equal(stored?.trust, "OWNER");
    assert.equal(stored?.chatName, "Demo Chat");

    const { filePath, entries } = chatLog.readKoishiChatLog(
      root,
      "telegram/123:456",
      "2026-04-04",
    );
    assert.match(filePath, /koishi-message-store[\\/]chat-log-view[\\/]/);
    assert.equal(entries.length, 2);
    assert.match(
      chatLog.formatKoishiChatLog(entries),
      /assistant: Good morning!/,
    );
  });
});
