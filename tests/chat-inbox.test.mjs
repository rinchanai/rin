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
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);

test("chat inbox enqueues a durable inbound envelope keyed by chat and message id", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "onebot",
    selfId: "1",
    channelId: "private:2",
    userId: "2",
    messageId: "m1",
    timestamp: Date.now(),
    content: "hello",
    stripped: { content: "hello" },
    author: { name: "tester" },
  };
  const elements = [{ type: "text", attrs: { content: "hello" } }];

  const { item } = inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "onebot/1:private:2",
    messageId: "m1",
    session,
    elements,
  });
  const files = inbox.listPendingChatInboxFiles(agentDir);

  assert.equal(files.length, 1);
  const loaded = inbox.readChatInboxItem(files[0]);
  assert.equal(loaded.itemId, item.itemId);
  assert.equal(loaded.chatKey, "onebot/1:private:2");
  assert.equal(loaded.messageId, "m1");
  assert.deepEqual(loaded.elements, elements);
});

test("chat inbox can claim, restore, and reschedule a queued envelope", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    userId: "3",
    messageId: "m2",
    timestamp: Date.now(),
    content: "hello again",
    stripped: { content: "hello again" },
  };
  const elements = [{ type: "text", attrs: { content: "hello again" } }];

  const { item } = inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:2",
    messageId: "m2",
    session,
    elements,
  });
  const [filePath] = inbox.listPendingChatInboxFiles(agentDir);
  const claimedPath = inbox.claimChatInboxFile(agentDir, filePath);
  const claimed = inbox.readChatInboxItem(claimedPath);
  assert.equal(claimed.itemId, item.itemId);

  inbox.restoreChatInboxFile(agentDir, claimedPath, claimed);
  const [restoredPath] = inbox.listPendingChatInboxFiles(agentDir);
  const restored = inbox.readChatInboxItem(restoredPath);
  assert.equal(restored.itemId, item.itemId);

  const reClaimedPath = inbox.claimChatInboxFile(agentDir, restoredPath);
  const reClaimed = inbox.readChatInboxItem(reClaimedPath);
  const next = inbox.requeueChatInboxFile(agentDir, reClaimedPath, reClaimed, {
    delayMs: 4000,
    error: "temporary_failure",
  });
  const [rescheduledPath] = inbox.listPendingChatInboxFiles(agentDir);
  const rescheduled = inbox.readChatInboxItem(rescheduledPath);
  assert.equal(rescheduled.attemptCount, 1);
  assert.equal(rescheduled.lastError, "temporary_failure");
  assert.equal(rescheduled.itemId, next.item.itemId);
  assert.ok(Date.parse(rescheduled.nextAttemptAt) > Date.now());
});
