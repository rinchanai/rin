import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const decision = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "decision.js")).href
);

const identity = {
  aliases: [
    { platform: "telegram", userId: "owner-1", personId: "owner" },
    { platform: "telegram", userId: "trusted-1", personId: "trusted" },
  ],
  persons: {
    owner: { trust: "OWNER" },
    trusted: { trust: "TRUSTED" },
  },
};

test("chat decision keeps slash-containing owner text routable", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      userId: "owner-1",
      content: "路径 /tmp/demo.txt 怎么处理？",
      stripped: { content: "路径 /tmp/demo.txt 怎么处理？" },
      isDirect: true,
    },
    [{ type: "text", attrs: { content: "路径 /tmp/demo.txt 怎么处理？" } }],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.text, "路径 /tmp/demo.txt 怎么处理？");
});

test("chat decision only enforces access policy, not custom slash-command guessing", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      userId: "owner-1",
      content: "/new hello",
      stripped: { content: "/new hello" },
      isDirect: true,
    },
    [{ type: "text", attrs: { content: "/new hello" } }],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.text, "/new hello");
});

test("chat decision allows trusted private messages", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      userId: "trusted-1",
      content: "hello from trusted",
      stripped: { content: "hello from trusted" },
      isDirect: true,
    },
    [{ type: "text", attrs: { content: "hello from trusted" } }],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.text, "hello from trusted");
  assert.equal(result.trust, "TRUSTED");
});

test("chat decision keeps image-only owner messages routable", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      userId: "owner-1",
      content: '<img src="https://example.com/demo.png" file="demo.png"/>',
      stripped: { content: "" },
      isDirect: true,
    },
    [
      {
        type: "img",
        attrs: { src: "https://example.com/demo.png", file: "demo.png" },
      },
    ],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.text, "");
});

test("chat decision allows owner group messages that explicitly at the bot even when stripped.appel is missing", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "group-1",
      channelId: "-1001447529496",
      selfId: "8623230033",
      userId: "owner-1",
      bot: {
        selfId: "8623230033",
        username: "THE_cattail_rin_chan_bot",
      },
      stripped: { content: "滴度" },
      elements: [
        { type: "at", attrs: { name: "THE_cattail_rin_chan_bot" } },
        { type: "text", attrs: { content: " 滴度" } },
      ],
    },
    [
      { type: "at", attrs: { name: "THE_cattail_rin_chan_bot" } },
      { type: "text", attrs: { content: " 滴度" } },
    ],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.chatKey, "telegram/8623230033:-1001447529496");
  assert.equal(result.text, "滴度");
});

test("chat decision ignores owner group messages that only at other users", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "group-1",
      channelId: "-1001447529496",
      selfId: "8623230033",
      userId: "owner-1",
      bot: {
        selfId: "8623230033",
        username: "THE_cattail_rin_chan_bot",
      },
      stripped: { content: "你看这个" },
      elements: [
        { type: "at", attrs: { name: "some_other_user" } },
        { type: "text", attrs: { content: " 你看这个" } },
      ],
    },
    [
      { type: "at", attrs: { name: "some_other_user" } },
      { type: "text", attrs: { content: " 你看这个" } },
    ],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.chatKey, "telegram/8623230033:-1001447529496");
  assert.equal(result.text, "你看这个");
});
