import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const rpc = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-koishi", "rpc.js")).href
);

async function withRpcServer(onConnection, fn) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-koishi-rpc-"));
  const socketDir = path.join(agentDir, "data", "koishi-sidecar");
  await fs.mkdir(socketDir, { recursive: true });
  const socketPath = path.join(socketDir, "rpc.sock");
  const server = net.createServer(onConnection);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await fn(agentDir);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("koishi rpc uses an extended timeout for chat turns", () => {
  assert.equal(
    rpc.koishiRpcTimeoutMsFor({ type: "run_chat_turn" }),
    10 * 60_000,
  );
  assert.equal(rpc.koishiRpcTimeoutMsFor({ type: "send_chat" }), 30_000);
});

test("koishi rpc returns response data from the sidecar socket", async () => {
  await withRpcServer(
    (socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => {
        socket.write(
          `${JSON.stringify({ success: true, data: { delivered: true } })}\n`,
        );
      });
    },
    async (agentDir) => {
      const result = await rpc.requestKoishiRpc(agentDir, {
        type: "send_chat",
      });
      assert.deepEqual(result, { delivered: true });
    },
  );
});

test("koishi rpc rejects invalid json responses from the sidecar socket", async () => {
  await withRpcServer(
    (socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => {
        socket.write("not-json\n");
      });
    },
    async (agentDir) => {
      await assert.rejects(
        rpc.requestKoishiRpc(agentDir, { type: "send_chat" }),
        /koishi_rpc_invalid_json/,
      );
    },
  );
});

test("koishi rpc surfaces explicit sidecar errors", async () => {
  await withRpcServer(
    (socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => {
        socket.write(
          `${JSON.stringify({ success: false, error: "unsupported_server_request" })}\n`,
        );
      });
    },
    async (agentDir) => {
      await assert.rejects(
        rpc.requestKoishiRpc(agentDir, { type: "unknown_command" }),
        /unsupported_server_request/,
      );
    },
  );
});
