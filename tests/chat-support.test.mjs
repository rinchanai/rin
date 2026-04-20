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

test("chat support keeps compose, parse, and normalize symmetric across bot requirements", () => {
  assert.equal(
    support.composeChatKey("discord", " channel-1 "),
    "discord:channel-1",
  );
  assert.equal(
    support.composeChatKey(" telegram ", " -100123 ", " 8623230033 "),
    "telegram/8623230033:-100123",
  );
  assert.equal(support.composeChatKey("telegram", "-100123"), "");
  assert.deepEqual(support.parseChatKey(" discord:channel-1 "), {
    platform: "discord",
    botId: "",
    chatId: "channel-1",
  });
  assert.equal(
    support.normalizeChatKey(" discord/:channel-1 "),
    undefined,
  );
  assert.equal(
    support.normalizeChatKey(" discord:channel-1 "),
    "discord:channel-1",
  );
  assert.equal(
    support.normalizeChatKey(" telegram/8623230033:-100123 "),
    "telegram/8623230033:-100123",
  );
});

test("chat support resolves current chat from session file when the session name is not a chat key", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-support-"));
  const dataDir = path.join(agentDir, "data");
  const sessionFile = path.join(agentDir, "sessions", "chat-session.jsonl");
  const statePath = support.chatStatePath(dataDir, "telegram/777:group-1");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "", "utf8");
  await fs.writeFile(
    statePath,
    JSON.stringify({ chatKey: "telegram/777:group-1", piSessionFile: sessionFile }),
    "utf8",
  );

  try {
    assert.equal(
      support.resolveChatKeyForSession(dataDir, {
        sessionName: "normal session name",
        sessionFile,
      }),
      "telegram/777:group-1",
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat support normalizes trust lookup and bot selection over dirty metadata", () => {
  assert.equal(
    support.trustOf(
      {
        aliases: [
          { platform: " telegram ", userId: " 42 ", personId: " owner " },
          { platform: "telegram", userId: "99", personId: "missing" },
        ],
        persons: {
          owner: { trust: " owner " },
        },
      },
      "telegram",
      "42",
    ),
    "OWNER",
  );
  assert.equal(
    support.trustOf(
      {
        aliases: [{ platform: "telegram", userId: "99", personId: "missing" }],
        persons: {},
      },
      "telegram",
      "99",
    ),
    "OTHER",
  );

  const app = {
    bots: [
      { platform: " telegram ", selfId: " 8623230033 ", name: "tg" },
      { platform: "discord", selfId: "1", name: "dc" },
    ],
  };
  assert.equal(
    support.findBot(app, "telegram", "8623230033")?.name,
    "tg",
  );
  assert.equal(support.findBot(app, "telegram") , null);
  assert.equal(support.findBot(app, "discord")?.name, "dc");
  assert.equal(support.findBot(app, "onebot", "1"), null);
});
