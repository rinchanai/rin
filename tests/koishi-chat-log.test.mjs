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

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-koishi-chat-log-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("koishi chat log appends and reads one day chat history", async () => {
  await withTempRoot(async (root) => {
    chatLog.appendKoishiChatLog(root, {
      timestamp: "2026-04-04T12:00:00.000Z",
      chatKey: "telegram/123:456",
      role: "user",
      text: "早上好",
      messageId: "m1",
      nickname: "Alice",
    });
    chatLog.appendKoishiChatLog(root, {
      timestamp: "2026-04-04T12:00:05.000Z",
      chatKey: "telegram/123:456",
      role: "assistant",
      text: "早上好呀",
      replyToMessageId: "m1",
    });

    const { filePath, entries } = chatLog.readKoishiChatLog(
      root,
      "telegram/123:456",
      "2026-04-04",
    );
    assert.match(
      filePath,
      /telegram[\\/]123[\\/]456[\\/]2026[\\/]04[\\/]04\.jsonl$/,
    );
    assert.equal(entries.length, 2);
    assert.match(chatLog.formatKoishiChatLog(entries), /assistant: 早上好呀/);
  });
});
