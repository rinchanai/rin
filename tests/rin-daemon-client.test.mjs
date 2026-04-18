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
const daemonClient = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "client.js")).href,
);

test("canConnectDaemonSocket reflects socket availability", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-daemon-client-"));
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  try {
    assert.equal(await daemonClient.canConnectDaemonSocket(socketPath, 200), true);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }

  assert.equal(await daemonClient.canConnectDaemonSocket(socketPath, 200), false);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

test("requestDaemonCommand reuses the shared daemon JSONL client", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-daemon-client-"));
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        requests.push(payload);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: { ok: true, echoedType: payload.type },
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  try {
    const result = await daemonClient.requestDaemonCommand(
      { id: "doctor_1", type: "daemon_status" },
      { socketPath, timeoutMs: 500 },
    );
    assert.deepEqual(result, { ok: true, echoedType: "daemon_status" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].id, "doctor_1");
    assert.equal(requests[0].type, "daemon_status");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
