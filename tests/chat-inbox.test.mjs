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

test("chat inbox preserves normalized mention routing hints needed for queued group turns", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "telegram",
    selfId: "1",
    guildId: "g1",
    channelId: "-100123",
    userId: "owner-1",
    messageId: "m-mention",
    timestamp: Date.now(),
    content: "@rin hello",
    stripped: { content: "hello", appel: true },
  };
  const elements = [{ type: "text", attrs: { content: "hello" } }];

  inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:-100123",
    messageId: "m-mention",
    session,
    elements,
  });
  const [filePath] = inbox.listPendingChatInboxFiles(agentDir);
  const loaded = inbox.readChatInboxItem(filePath);
  const restored = inbox.restoreChatInboxSession({
    ...loaded,
    session: {
      ...loaded.session,
      stripped: { content: loaded.session?.stripped?.content },
    },
  });

  assert.equal(loaded.routing?.mentionLike, true);
  assert.equal(loaded.routing?.chatType, "group");
  assert.equal(loaded.session?.stripped?.content, "hello");
  assert.equal(loaded.session?.stripped?.appel, undefined);
  assert.equal(restored.stripped?.appel, true);
});

test("chat inbox restores stranded processing envelopes back to pending on startup", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    userId: "3",
    messageId: "m-processing",
    timestamp: Date.now(),
    content: "hello again",
    stripped: { content: "hello again" },
  };
  const elements = [{ type: "text", attrs: { content: "hello again" } }];

  inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:2",
    messageId: "m-processing",
    session,
    elements,
  });
  const [pendingPath] = inbox.listPendingChatInboxFiles(agentDir);
  const claimedPath = inbox.claimChatInboxFile(agentDir, pendingPath);
  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 1);

  const restored = inbox.restoreProcessingChatInboxFiles(agentDir);
  assert.equal(restored.length, 1);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  const [restoredPath] = inbox.listPendingChatInboxFiles(agentDir);
  const restoredItem = inbox.readChatInboxItem(restoredPath);
  assert.equal(restoredItem.messageId, "m-processing");
  assert.ok(restoredPath.endsWith(`${restoredItem.itemId}.json`));
  assert.ok(claimedPath.endsWith(`${restoredItem.itemId}.json`));
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


test("chat inbox moves failed envelopes into failed storage with updated metadata", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    userId: "3",
    messageId: "m-fail",
    timestamp: Date.now(),
    content: "hello failure",
    stripped: { content: "hello failure" },
  };
  const elements = [{ type: "text", attrs: { content: "hello failure" } }];

  const { item } = inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:2",
    messageId: "m-fail",
    session,
    elements,
  });
  const [filePath] = inbox.listPendingChatInboxFiles(agentDir);
  const claimedPath = inbox.claimChatInboxFile(agentDir, filePath);
  const claimed = inbox.readChatInboxItem(claimedPath);
  const failed = inbox.failChatInboxFile(
    agentDir,
    claimedPath,
    claimed,
    "fatal_failure",
  );

  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  assert.equal(failed.item.itemId, item.itemId);
  assert.equal(failed.item.attemptCount, 1);
  assert.equal(failed.item.lastError, "fatal_failure");
  assert.ok(failed.filePath.endsWith(`${item.itemId}.json`));

  const loaded = inbox.readChatInboxItem(failed.filePath);
  assert.equal(loaded.itemId, item.itemId);
  assert.equal(loaded.attemptCount, 1);
  assert.equal(loaded.lastError, "fatal_failure");
});
