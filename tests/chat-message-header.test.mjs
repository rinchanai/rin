import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
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
