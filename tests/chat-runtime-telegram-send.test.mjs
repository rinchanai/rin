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
const runtime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js"))
    .href,
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-runtime-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("telegram adapter splits oversized text sends and keeps the reply only on the first chunk", async () => {
  await withTempDir(async (agentDir) => {
    const app = runtime.createChatRuntimeApp(agentDir);
    runtime.instantiateBuiltInChatRuntimeAdapters(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      adapterEntries: [
        { key: "telegram", name: "Telegram", config: { token: "123:abc" } },
      ],
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls = [];
    adapter.callApi = async (method, payload) => {
      calls.push({ method, payload });
      return { message_id: String(calls.length) };
    };

    const result = await app.bots[0].sendMessage("456", [
      h.quote("99"),
      h.text("a".repeat(4100)),
    ]);

    assert.deepEqual(result, ["1", "2"]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((entry) => entry.method), [
      "sendMessage",
      "sendMessage",
    ]);
    assert.equal(calls[0].payload.chat_id, "456");
    assert.equal(calls[0].payload.reply_to_message_id, "99");
    assert.equal(calls[0].payload.text.length, 4096);
    assert.equal(calls[1].payload.reply_to_message_id, undefined);
    assert.equal(calls[1].payload.text, "a".repeat(4));
  });
});

test("telegram adapter keeps media first and spills oversized captions into follow-up text messages", async () => {
  await withTempDir(async (agentDir) => {
    const app = runtime.createChatRuntimeApp(agentDir);
    runtime.instantiateBuiltInChatRuntimeAdapters(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      adapterEntries: [
        { key: "telegram", name: "Telegram", config: { token: "123:abc" } },
      ],
    });
    const adapter = [...app.adapters][0];
    const h = runtime.createChatRuntimeH();
    const calls = [];
    adapter.callApi = async (method, payload) => {
      calls.push({ method, payload });
      return { message_id: String(calls.length) };
    };

    const result = await app.bots[0].sendMessage("456", [
      h.quote("77"),
      h.image("https://example.com/demo.png"),
      h.text("b".repeat(1030)),
    ]);

    assert.deepEqual(result, ["1", "2"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "sendPhoto");
    assert.equal(calls[0].payload.reply_to_message_id, "77");
    assert.equal(calls[0].payload.caption.length, 1024);
    assert.equal(calls[1].method, "sendMessage");
    assert.equal(calls[1].payload.reply_to_message_id, undefined);
    assert.equal(calls[1].payload.text, "b".repeat(6));
  });
});
