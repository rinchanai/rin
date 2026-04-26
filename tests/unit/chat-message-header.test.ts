import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const messageHeaderMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-bridge", "message-header.js"),
  ).href
);
const promptContextMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-bridge", "prompt-context.js"),
  ).href
);

function createPi() {
  const handlers = new Map();
  const entries = [];
  return {
    handlers,
    entries,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
  };
}

test("chat message header focuses sender identity guidance in the system prompt", async () => {
  const pi = createPi();
  messageHeaderMod.default(pi);

  promptContextMod.enqueueChatPromptContext({
    source: "chat-bridge",
    sentAt: Date.now(),
    chatKey: "telegram/1:2",
    chatType: "group",
    userId: "guest-1",
    nickname: "Alice",
    identity: "OTHER",
  });

  const inputResult = await pi.handlers.get("input")[0]({
    source: "chat-bridge",
    text: "你好",
  });
  assert.deepEqual(inputResult, { action: "continue" });

  const beforeStart = await pi.handlers.get("before_agent_start")[0]({
    prompt: "你好",
    systemPrompt: "Base prompt",
  });

  const systemPrompt = String(beforeStart?.systemPrompt || "");
  const header = String(beforeStart?.message?.content || "");

  assert.ok(
    systemPrompt.includes(
      "The injected message header above `---` is runtime metadata for the current message, not user-authored text.",
    ),
  );
  assert.ok(
    systemPrompt.includes(
      "Use `sender trust` to identify who is speaking: `owner` means the owner, `trusted user` means a known trusted chat user, and `other chat user` means any other chat user.",
    ),
  );
  assert.equal(systemPrompt.includes("owner-only"), false);
  assert.ok(header.includes("sender nickname: Alice"));
  assert.equal(header.includes("sender is owner:"), false);
  assert.ok(header.includes("sender trust: other chat user"));
});

test("chat message header remembers stable system prompt blocks for forked sessions", async () => {
  const pi = createPi();
  messageHeaderMod.default(pi);

  promptContextMod.enqueueChatPromptContext({
    source: "chat-bridge",
    sentAt: Date.now(),
    chatKey: "telegram/1:2",
    chatType: "group",
    userId: "guest-1",
    nickname: "Alice",
    identity: "OTHER",
  });

  await pi.handlers.get("input")[0]({
    source: "chat-bridge",
    text: "你好",
  });

  await pi.handlers.get("before_agent_start")[0](
    {
      prompt: "你好",
      systemPrompt: "Base prompt",
    },
    {
      sessionManager: {
        getBranch: () => [],
      },
    },
  );

  assert.equal(pi.entries.length, 1);
  assert.equal(pi.entries[0].customType, "rin-system-prompt-blocks");
  assert.ok(
    pi.entries[0].data.blocks.some((block) =>
      block.includes("Chat bridge guidelines:"),
    ),
  );
});

test("chat message header keeps owner senders marked as owner", async () => {
  const pi = createPi();
  messageHeaderMod.default(pi);

  promptContextMod.enqueueChatPromptContext({
    source: "chat-bridge",
    sentAt: Date.now(),
    chatKey: "telegram/1:2",
    chatType: "private",
    userId: "owner-1",
    nickname: "Master",
    identity: "OWNER",
  });

  const inputResult = await pi.handlers.get("input")[0]({
    source: "chat-bridge",
    text: "你好",
  });
  assert.deepEqual(inputResult, { action: "continue" });

  const beforeStart = await pi.handlers.get("before_agent_start")[0]({
    prompt: "你好",
    systemPrompt: "Base prompt",
  });

  const systemPrompt = String(beforeStart?.systemPrompt || "");
  const header = String(beforeStart?.message?.content || "");
  assert.equal(systemPrompt.includes("owner-only"), false);
  assert.equal(header.includes("sender is owner:"), false);
  assert.ok(header.includes("sender trust: owner"));
});

test("chat message header keeps trusted senders distinct from owner", async () => {
  const pi = createPi();
  messageHeaderMod.default(pi);

  promptContextMod.enqueueChatPromptContext({
    source: "chat-bridge",
    sentAt: Date.now(),
    chatKey: "telegram/1:2",
    chatType: "group",
    userId: "trusted-1",
    nickname: "Bob",
    identity: "TRUSTED",
  });

  const inputResult = await pi.handlers.get("input")[0]({
    source: "chat-bridge",
    text: "你好",
  });
  assert.deepEqual(inputResult, { action: "continue" });

  const beforeStart = await pi.handlers.get("before_agent_start")[0]({
    prompt: "你好",
    systemPrompt: "Base prompt",
  });

  const header = String(beforeStart?.message?.content || "");
  assert.equal(header.includes("sender is owner:"), false);
  assert.ok(header.includes("sender trust: trusted user"));
});

test("chat message header injects available reply message content", async () => {
  const pi = createPi();
  messageHeaderMod.default(pi);

  promptContextMod.enqueueChatPromptContext({
    source: "chat-bridge",
    sentAt: Date.now(),
    chatKey: "telegram/1:2",
    chatType: "group",
    userId: "guest-1",
    nickname: "Alice",
    identity: "OTHER",
    replyToMessageId: "quoted-42",
    replyMessage: {
      messageId: "quoted-42",
      userId: "guest-2",
      nickname: "Carol",
      text: "第一行\n第二行",
    },
  });

  const inputResult = await pi.handlers.get("input")[0]({
    source: "chat-bridge",
    text: "这条是什么意思？",
  });
  assert.deepEqual(inputResult, { action: "continue" });

  const beforeStart = await pi.handlers.get("before_agent_start")[0]({
    prompt: "这条是什么意思？",
    systemPrompt: "Base prompt",
  });

  const systemPrompt = String(beforeStart?.systemPrompt || "");
  const header = String(beforeStart?.message?.content || "");
  assert.ok(header.includes("reply to message id: quoted-42"));
  assert.ok(header.includes("reply message:"));
  assert.ok(header.includes("  nickname: Carol"));
  assert.ok(header.includes("  text:\n  第一行\n  第二行"));
  assert.ok(
    systemPrompt.includes("includes the available replied-message content"),
  );
});
