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
const transport = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-koishi", "transport.js"),
  ).href
);
const messageStore = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-koishi", "message-store.js"),
  ).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-transport-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("koishi transport buildPromptText keeps the original text intact", () => {
  const result = transport.buildPromptText("hello", [
    { kind: "file", path: "/tmp/a.txt", name: "a.txt" },
    { kind: "image", path: "/tmp/b.png", name: "b.png" },
  ]);
  assert.equal(result, "hello");
});

test("koishi transport keeps image-only prompts native", () => {
  const result = transport.buildPromptText("", [
    { kind: "image", path: "/tmp/b.png", name: "b.png" },
  ]);
  assert.equal(result, "");
});

test("koishi transport restorePromptParts rebuilds image payloads from disk", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    await fs.writeFile(imagePath, Buffer.from("abc"));
    const restored = await transport.restorePromptParts({
      text: "hi",
      startedAt: Date.now(),
      attachments: [
        {
          kind: "image",
          path: imagePath,
          name: "demo.png",
          mimeType: "image/png",
        },
      ],
    });
    assert.equal(restored.text, "hi");
    assert.equal(restored.images.length, 1);
    assert.equal(restored.images[0].mimeType, "image/png");
  });
});

test("koishi transport forwards mixed parts as a single native koishi send", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    await fs.writeFile(imagePath, Buffer.from("abc"));
    messageStore.saveKoishiMessage(dir, {
      messageId: "42",
      chatKey: "telegram/1:2",
      platform: "telegram",
      botId: "1",
      chatId: "2",
      chatType: "private",
      receivedAt: "2026-04-07T00:00:00.000Z",
      sessionId: "sess-42",
      sessionFile: "/tmp/sess-42.jsonl",
      text: "incoming",
    });
    const sends = [];
    await transport.sendOutboxPayload(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "1",
            async sendMessage(chatId, content) {
              sends.push({ chatId, content });
              return ["m1"];
            },
          },
        ],
      },
      dir,
      {
        type: "parts_delivery",
        chatKey: "telegram/1:2",
        parts: [
          { type: "quote", id: "42" },
          { type: "text", text: "intro" },
          { type: "image", path: imagePath, mimeType: "image/png" },
          { type: "image", path: imagePath, mimeType: "image/png" },
        ],
      },
      Object.assign((type, attrs) => ({ type, attrs }), {
        text(content) {
          return { type: "text", attrs: { content } };
        },
        quote(id) {
          return { type: "quote", attrs: { id } };
        },
      }),
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0].chatId, "2");
    assert.equal(sends[0].content[0].type, "quote");
    assert.equal(sends[0].content[1].type, "text");
    assert.equal(sends[0].content[2].type, "image");
    assert.equal(sends[0].content[3].type, "image");

    const stored = messageStore.getKoishiMessage(dir, "telegram/1:2", "m1");
    assert.equal(stored?.text, "intro");
    assert.equal(stored?.replyToMessageId, "42");
    assert.equal(stored?.sessionId, "sess-42");
    assert.equal(stored?.sessionFile, "/tmp/sess-42.jsonl");
  });
});

test("koishi transport stores explicit session binding for outbox text deliveries", async () => {
  await withTempDir(async (dir) => {
    await transport.sendOutboxPayload(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "1",
            async sendMessage() {
              return ["m-text"];
            },
          },
        ],
      },
      dir,
      {
        type: "text_delivery",
        chatKey: "telegram/1:2",
        text: "scheduled hello",
        sessionId: "sess-task",
        sessionFile: "/tmp/task-session.jsonl",
      },
      Object.assign((type, attrs) => ({ type, attrs }), {
        text(content) {
          return { type: "text", attrs: { content } };
        },
        quote(id) {
          return { type: "quote", attrs: { id } };
        },
      }),
    );
    const stored = messageStore.getKoishiMessage(dir, "telegram/1:2", "m-text");
    assert.equal(stored?.text, "scheduled hello");
    assert.equal(stored?.sessionId, "sess-task");
    assert.equal(stored?.sessionFile, "/tmp/task-session.jsonl");
  });
});

test("koishi transport keeps local image parts as file urls instead of inlining data urls", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    await fs.writeFile(imagePath, Buffer.from("abc"));
    const h = Object.assign((type, attrs) => ({ type, attrs }), {
      image(src) {
        return { type: "img", attrs: { src } };
      },
      text(content) {
        return { type: "text", attrs: { content } };
      },
      at(id, options) {
        return { type: "at", attrs: { id, ...options } };
      },
      file(src, mimeType, options) {
        return { type: "file", attrs: { src, mimeType, ...options } };
      },
    });
    const node = await transport.messagePartToNode(
      { type: "image", path: imagePath, mimeType: "image/png" },
      h,
    );
    assert.equal(node.type, "image");
    assert.match(node.attrs.src, /^file:\/\//);
    assert.equal(node.attrs.mimeType, "image/png");
  });
});

test("koishi transport treats empty bot send results as delivery failures", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      transport.sendOutboxPayload(
        {
          bots: [
            {
              platform: "telegram",
              selfId: "1",
              async sendMessage() {
                return [];
              },
            },
          ],
        },
        dir,
        {
          type: "parts_delivery",
          chatKey: "telegram/1:2",
          parts: [{ type: "text", text: "hello" }],
        },
        {
          text(content) {
            return { type: "text", attrs: { content } };
          },
          quote(id) {
            return { type: "quote", attrs: { id } };
          },
        },
      ),
      /chat_send_message_empty_result/,
    );
  });
});

test("koishi transport prefers internal telegram reaction calls for working reactions", async () => {
  const calls = [];
  const app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        internal: {
          async setMessageReaction(payload) {
            calls.push(payload);
          },
        },
      },
    ],
  };

  const first = await transport.rotateWorkingReaction(
    app,
    "telegram/1:2",
    "41",
    0,
    "",
  );
  const second = await transport.rotateWorkingReaction(
    app,
    "telegram/1:2",
    "41",
    1,
    first,
  );
  const cleared = await transport.clearWorkingReaction(
    app,
    "telegram/1:2",
    "41",
    second,
  );

  assert.equal(first, "🌘");
  assert.equal(second, "🌘");
  assert.equal(cleared, true);
  assert.deepEqual(calls, [
    {
      chat_id: "2",
      message_id: 41,
      reaction: [{ type: "emoji", emoji: "🌘" }],
    },
    {
      chat_id: "2",
      message_id: 41,
      reaction: [],
    },
  ]);
});

test("koishi transport uses bot reaction helpers for onebot working reactions", async () => {
  const calls = [];
  const app = {
    bots: [
      {
        platform: "onebot",
        selfId: "2301401877",
        async createReaction(chatId, messageId, emoji) {
          calls.push({ kind: "create", chatId, messageId, emoji });
        },
        async deleteReaction(chatId, messageId, emoji, userId) {
          calls.push({ kind: "delete", chatId, messageId, emoji, userId });
        },
      },
    ],
  };

  const first = await transport.rotateWorkingReaction(
    app,
    "onebot/2301401877:1067390680",
    "52",
    0,
    "",
  );
  const second = await transport.rotateWorkingReaction(
    app,
    "onebot/2301401877:1067390680",
    "52",
    1,
    first,
  );
  const cleared = await transport.clearWorkingReaction(
    app,
    "onebot/2301401877:1067390680",
    "52",
    second,
  );

  assert.equal(first, "👍");
  assert.equal(second, "👍");
  assert.equal(cleared, true);
  assert.deepEqual(calls, [
    { kind: "create", chatId: "1067390680", messageId: "52", emoji: "👍" },
    {
      kind: "delete",
      chatId: "1067390680",
      messageId: "52",
      emoji: "👍",
      userId: "2301401877",
    },
  ]);
});

test("koishi transport skips onebot working reactions in private chats", async () => {
  const app = {
    bots: [
      {
        platform: "onebot",
        selfId: "2301401877",
        async createReaction() {
          throw new Error("onebot_reaction_requires_group_chat");
        },
        async deleteReaction() {
          throw new Error("onebot_reaction_requires_group_chat");
        },
      },
    ],
  };

  const first = await transport.rotateWorkingReaction(
    app,
    "onebot/2301401877:private:519418441",
    "52",
    0,
    "",
  );
  const cleared = await transport.clearWorkingReaction(
    app,
    "onebot/2301401877:private:519418441",
    "52",
    "👍",
  );

  assert.equal(first, "");
  assert.equal(cleared, false);
});
