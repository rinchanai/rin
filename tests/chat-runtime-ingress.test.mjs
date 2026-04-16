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
const runtime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);

test("chat runtime persists inbound sessions before emitting message events", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-runtime-"));
  const app = runtime.createChatRuntimeApp(agentDir);
  const seen = [];
  app.on("message", (session) => {
    seen.push(session.messageId);
  });

  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    messageId: "m1",
    userId: "u1",
    content: "hello",
    stripped: { content: "hello" },
    elements: [{ type: "text", attrs: { content: "hello" } }],
  };

  const delivered = app.emit("message", session);
  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);

  assert.equal(delivered, true);
  assert.deepEqual(seen, ["m1"]);
  assert.equal(session.__rinInboundQueued, true);
  assert.equal(files.length, 1);
  assert.equal(stored.chatKey, "telegram/1:2");
  assert.equal(stored.messageId, "m1");
});

test("chat runtime derives the durable chat key from normalized chat identity", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-runtime-"));
  const app = runtime.createChatRuntimeApp(agentDir);

  const session = {
    platform: "onebot",
    selfId: "1",
    userId: "42",
    messageId: "m2",
    isDirect: true,
    content: "hello",
    stripped: { content: "hello" },
    elements: [{ type: "text", attrs: { content: "hello" } }],
  };

  app.emit("message", session);
  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);

  assert.equal(files.length, 1);
  assert.equal(stored.chatKey, "onebot/1:private:42");
  assert.equal(stored.messageId, "m2");
});
