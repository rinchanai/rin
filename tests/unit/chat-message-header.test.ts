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
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
}

test("chat prompt context packages sender identity guidance into the prompt text", () => {
  const promptText = promptContextMod.formatPromptContext(
    {
      source: "chat-bridge",
      sentAt: 1710000000000,
      chatKey: "telegram/1:2",
      chatType: "group",
      userId: "guest-1",
      nickname: "Alice",
      identity: "OTHER",
    },
    "你好",
  );

  assert.ok(promptText.startsWith("time: "));
  assert.ok(promptText.includes("chatKey: telegram/1:2"));
  assert.ok(
    promptText.includes(
      "runtime note: header lines above `---` are runtime metadata for this message, not user-authored text.",
    ),
  );
  assert.ok(promptText.includes("sender nickname: Alice"));
  assert.ok(promptText.includes("sender trust: other chat user"));
  assert.ok(
    promptText.includes(
      "sender trust note: owner means the owner, trusted user means a known trusted chat user, and other chat user means any other chat user.",
    ),
  );
  assert.equal(promptText.includes("sender is owner:"), false);
  assert.ok(promptText.endsWith("---\n你好"));
});

test("message header skips duplicate metadata for already formatted chat prompts", async () => {
  const pi = createPi();
  messageHeaderMod.default(pi);

  const promptText = promptContextMod.formatPromptContext(
    {
      source: "chat-bridge",
      sentAt: Date.now(),
      chatKey: "onebot/1:2",
      chatType: "group",
      userId: "guest-1",
      nickname: "很酷",
      identity: "OTHER",
    },
    "@☆铃酱☆ my name is?",
  );

  const inputResult = await pi.handlers.get("input")[0]({
    source: "chat-bridge",
    text: promptText,
  });
  assert.deepEqual(inputResult, { action: "continue" });

  const beforeStart = await pi.handlers.get("before_agent_start")[0]({
    prompt: promptText,
    systemPrompt: "Base prompt",
  });

  assert.deepEqual(beforeStart, {});
});

test("message header still injects a local hidden timestamp for non-chat prompts", async () => {
  const pi = createPi();
  messageHeaderMod.default(pi);

  const inputResult = await pi.handlers.get("input")[0]({
    source: "user",
    text: "你好",
  });
  assert.deepEqual(inputResult, { action: "continue" });

  const beforeStart = await pi.handlers.get("before_agent_start")[0]({
    prompt: "你好",
    systemPrompt: "Base prompt",
  });

  const header = String(beforeStart?.message?.content || "");
  assert.ok(header.startsWith("time: "));
  assert.ok(header.endsWith("---\n你好"));
  assert.equal(String(beforeStart?.systemPrompt || ""), "");
});

test("chat prompt context requires reply lookup without injecting replied text", () => {
  const promptText = promptContextMod.formatPromptContext(
    {
      source: "chat-bridge",
      sentAt: Date.now(),
      chatKey: "telegram/1:2",
      chatType: "group",
      userId: "guest-1",
      nickname: "Alice",
      identity: "OTHER",
      replyToMessageId: "quoted-42",
    },
    "这条是什么意思？",
  );

  assert.ok(promptText.includes("reply to message id: quoted-42"));
  assert.equal(promptText.includes("reply message:"), false);
  assert.equal(promptText.includes("第一行"), false);
  assert.ok(
    promptText.includes(
      "reply lookup: call get_chat_msg with that exact message id before answering",
    ),
  );
});

test("chat prompt context keeps owner and trusted senders distinct", () => {
  const ownerPrompt = promptContextMod.formatPromptContext(
    {
      source: "chat-bridge",
      sentAt: Date.now(),
      chatKey: "telegram/1:2",
      chatType: "private",
      userId: "owner-1",
      nickname: "Master",
      identity: "OWNER",
    },
    "你好",
  );
  const trustedPrompt = promptContextMod.formatPromptContext(
    {
      source: "chat-bridge",
      sentAt: Date.now(),
      chatKey: "telegram/1:2",
      chatType: "group",
      userId: "trusted-1",
      nickname: "Bob",
      identity: "TRUSTED",
    },
    "你好",
  );

  assert.ok(ownerPrompt.includes("sender trust: owner"));
  assert.ok(trustedPrompt.includes("sender trust: trusted user"));
  assert.equal(ownerPrompt.includes("sender is owner:"), false);
  assert.equal(trustedPrompt.includes("sender is owner:"), false);
});
