import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const support = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js"))
    .href,
);

test("chat support infers chat types from normalized targets", () => {
  assert.equal(
    support.inferChatType({ platform: "telegram", chatId: "123456" }),
    "private",
  );
  assert.equal(
    support.inferChatType({ platform: "telegram", chatId: "-100123" }),
    "group",
  );
  assert.equal(
    support.inferChatType({ platform: "onebot", chatId: "private:42" }),
    "private",
  );
  assert.equal(
    support.inferChatType({ platform: "onebot", chatId: "1067390680" }),
    "group",
  );
  assert.equal(
    support.inferChatType({ platform: "discord", chatId: "channel-1" }),
    "group",
  );
});

test("chat support parses shared chat targets for private detection", () => {
  const parsed = support.parseChatKey("onebot/2301401877:private:519418441");
  assert.deepEqual(parsed, {
    platform: "onebot",
    botId: "2301401877",
    chatId: "private:519418441",
  });
  assert.equal(support.isPrivateChat(parsed), true);
});
