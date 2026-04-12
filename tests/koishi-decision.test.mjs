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
