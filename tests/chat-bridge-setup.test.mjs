import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const setup = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-bridge", "setup.js"))
    .href
);

function createPromptHarness(answers) {
  const queues = {
    select: [...(answers.select || [])],
    text: [...(answers.text || [])],
    confirm: [...(answers.confirm || [])],
  };
  return {
    ensureNotCancelled(value) {
      if (value === undefined || value === null) throw new Error("cancelled");
      return value;
    },
    async select() {
      return queues.select.shift();
    },
    async text() {
      return queues.text.shift();
    },
    async confirm() {
      return queues.confirm.shift();
    },
  };
}

test("chat bridge setup configures Telegram with minimal polling defaults", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["telegram"],
      text: ["123456:ABCDEF"],
    }),
  );

  assert.equal(result.adapterKey, "telegram");
  assert.equal(result.koishiDescription, "Telegram");
  assert.deepEqual(result.koishiConfig, {
    telegram: {
      token: "123456:ABCDEF",
      protocol: "polling",
      slash: true,
    },
  });
});

test("chat bridge setup configures Slack with socket mode defaults", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["slack"],
      text: ["xapp-demo", "xoxb-demo"],
    }),
  );

  assert.equal(result.adapterKey, "slack");
  assert.equal(result.koishiDescription, "Slack");
  assert.deepEqual(result.koishiConfig, {
    slack: {
      protocol: "ws",
      token: "xapp-demo",
      botToken: "xoxb-demo",
    },
  });
});

test("chat bridge setup configures mail preset with minimal required fields", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["mail", "qq"],
      text: ["bot@qq.com", "auth-code"],
    }),
  );

  assert.equal(result.adapterKey, "mail");
  assert.deepEqual(result.koishiConfig, {
    mail: {
      username: "bot@qq.com",
      password: "auth-code",
      imap: { host: "imap.qq.com", port: 993, tls: true },
      smtp: { host: "smtp.qq.com", port: 465, tls: true },
    },
  });
});

test("chat bridge setup configures Feishu / Lark with websocket defaults", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["lark", "feishu"],
      text: ["cli_xxx", "secret_xxx"],
    }),
  );

  assert.equal(result.adapterKey, "lark");
  assert.deepEqual(result.koishiConfig, {
    lark: {
      platform: "feishu",
      protocol: "ws",
      appId: "cli_xxx",
      appSecret: "secret_xxx",
    },
  });
});

test("chat bridge setup can skip the installer yes-no gate", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      select: ["telegram"],
      text: ["123456:ABCDEF"],
    }),
    { confirmEnable: false },
  );

  assert.equal(result.adapterKey, "telegram");
  assert.deepEqual(result.koishiConfig, {
    telegram: {
      token: "123456:ABCDEF",
      protocol: "polling",
      slash: true,
    },
  });
});
