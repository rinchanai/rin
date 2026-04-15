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

test("chat bridge guided setup configures Telegram with slash toggle", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true, false],
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
      slash: false,
    },
  });
});

test("chat bridge guided setup configures Slack http mode", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["slack", "http"],
      text: ["xapp-demo", "xoxb-demo", "signing-secret"],
    }),
  );

  assert.equal(result.adapterKey, "slack");
  assert.equal(result.koishiDescription, "Slack");
  assert.deepEqual(result.koishiConfig, {
    slack: {
      protocol: "http",
      token: "xapp-demo",
      botToken: "xoxb-demo",
      signing: "signing-secret",
    },
  });
});

test("chat bridge guided setup configures mail with provider preset", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true, true, true, true],
      select: ["mail", "qq"],
      text: [
        "bot@qq.com",
        "auth-code",
        "bot@qq.com",
        "Rin Mail",
        "imap.qq.com",
        "993",
        "smtp.qq.com",
        "465",
      ],
    }),
  );

  assert.equal(result.adapterKey, "mail");
  assert.deepEqual(result.koishiConfig, {
    mail: {
      username: "bot@qq.com",
      password: "auth-code",
      selfId: "bot@qq.com",
      subject: "Rin Mail",
      imap: { host: "imap.qq.com", port: 993, tls: true },
      smtp: { host: "smtp.qq.com", port: 465, tls: true },
    },
  });
});
