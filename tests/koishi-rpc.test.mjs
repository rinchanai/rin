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

test("koishi rpc resolves socket paths under the sidecar runtime directory", () => {
  assert.equal(
    rpc.koishiRpcSocketPath("/tmp/rin-agent"),
    path.join("/tmp/rin-agent", "data", "koishi-sidecar", "rpc.sock"),
  );
  assert.equal(
    rpc.koishiRpcSocketPath("./tmp/../tmp/rin-agent"),
    path.resolve("./tmp/rin-agent", "data", "koishi-sidecar", "rpc.sock"),
  );
});

test("koishi rpc uses stable timeout defaults across command shapes", () => {
  assert.equal(
    rpc.koishiRpcTimeoutMsFor({ type: "run_chat_turn" }),
    10 * 60_000,
  );
  assert.equal(
    rpc.koishiRpcTimeoutMsFor({ type: " run_chat_turn " }),
    10 * 60_000,
  );
  assert.equal(rpc.koishiRpcTimeoutMsFor({ type: "send_chat" }), 30_000);
  assert.equal(rpc.koishiRpcTimeoutMsFor({ type: "unknown" }), 30_000);
  assert.equal(rpc.koishiRpcTimeoutMsFor({}), 30_000);
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

test("koishi rpc assembles split response chunks before parsing", async () => {
  await withRpcServer(
    (socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => {
        const line = `${JSON.stringify({ success: true, data: { delivered: true } })}\n`;
        socket.write(line.slice(0, 10));
        setTimeout(() => socket.write(line.slice(10)), 5);
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

test("koishi rpc skips blank lines and accepts CRLF responses", async () => {
  await withRpcServer(
    (socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => {
        socket.write(
          `\n${JSON.stringify({ success: true, data: { delivered: true } })}\r\n`,
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

test("koishi rpc times out when the sidecar never responds", async () => {
  await withRpcServer(
    (socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => {
        // Intentionally keep the socket open without replying.
      });
    },
    async (agentDir) => {
      await assert.rejects(
        rpc.requestKoishiRpc(agentDir, { type: "send_chat" }, 20),
        /koishi_rpc_timeout:send_chat/,
      );
    },
  );
});

test("koishi rpc falls back to the raw payload when the sidecar omits data", async () => {
  await withRpcServer(
    (socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => {
        socket.write(`${JSON.stringify({ success: true, delivered: true })}\n`);
      });
    },
    async (agentDir) => {
      const result = await rpc.requestKoishiRpc(agentDir, {
        type: "send_chat",
      });
      assert.deepEqual(result, { success: true, delivered: true });
    },
  );
});

test("koishi rpc surfaces socket connection failures", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-koishi-rpc-"));
  try {
    await assert.rejects(
      rpc.requestKoishiRpc(agentDir, { type: "send_chat" }, 20),
      /ENOENT|ECONNREFUSED/,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("koishi rpc deliver helper sends chat payloads through send_chat", async () => {
  await withRpcServer(
    (socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => {
        const command = JSON.parse(String(chunk).trim());
        assert.equal(command.type, "send_chat");
        assert.deepEqual(command.payload, {
          chatKey: "onebot/123:456",
          parts: [{ type: "text", text: "hello" }],
        });
        socket.write(
          `${JSON.stringify({ success: true, data: { delivered: true } })}\n`,
        );
      });
    },
    async (agentDir) => {
      const result = await rpc.deliverKoishiRpcPayload(agentDir, {
        chatKey: "onebot/123:456",
        parts: [{ type: "text", text: "hello" }],
      });
      assert.deepEqual(result, { delivered: true });
    },
  );
});
