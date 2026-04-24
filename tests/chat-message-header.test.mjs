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

test("chat message header explains sender identity tiers in the system prompt", async () => {
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
      "`sender trust: trusted user` means a known trusted user; all other identities are external users.",
    ),
  );
  assert.equal(
    systemPrompt.includes("- Injected message header fields:"),
    false,
  );
  assert.ok(header.includes("sender nickname: Alice"));
  assert.ok(header.includes("sender is owner: no"));
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
  assert.ok(
    systemPrompt.includes(
      "`sender is owner: yes` and `sender trust: owner` mean the owner;",
    ),
  );
  assert.ok(header.includes("sender is owner: yes"));
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
  assert.ok(header.includes("sender is owner: no"));
  assert.ok(header.includes("sender trust: trusted user"));
});
