import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const decision = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-koishi", "decision.js"))
    .href
);

const identity = {
  aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
  persons: { owner: { trust: "OWNER" } },
};

test("koishi decision keeps slash-containing owner text routable", async () => {
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

test("koishi decision only enforces access policy, not custom slash-command guessing", async () => {
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

test("koishi decision keeps image-only owner messages routable", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      userId: "owner-1",
      content: '<img src="https://example.com/demo.png" file="demo.png"/>',
      stripped: { content: "" },
      isDirect: true,
    },
    [{ type: "img", attrs: { src: "https://example.com/demo.png", file: "demo.png" } }],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.text, "");
});

test("koishi decision allows owner group messages that explicitly at the bot even when stripped.appel is missing", async () => {
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
