import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const rpc = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-koishi", "rpc.js")).href
);

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "rin-koishi-rpc-test-"),
  );
  try {
    await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

test("koishi rpc client sends one command and reads success response", async () => {
  await withTempDir(async (agentDir) => {
    const socketPath = rpc.koishiRpcSocketPath(agentDir);
    await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
    const received = [];
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        const idx = buffer.indexOf("\n");
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        received.push(JSON.parse(line));
        socket.write(
          `${JSON.stringify({ success: true, data: { delivered: true } })}\n`,
        );
      });
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const result = await rpc.deliverKoishiRpcPayload(agentDir, {
        type: "text_delivery",
        createdAt: new Date().toISOString(),
        chatKey: "telegram/1:2",
        text: "hello",
      });
      assert.deepEqual(result, { delivered: true });
      assert.equal(received.length, 1);
      assert.equal(received[0].type, "send_chat");
      assert.equal(received[0].payload.chatKey, "telegram/1:2");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
