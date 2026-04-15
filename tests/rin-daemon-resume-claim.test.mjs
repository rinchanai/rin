import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

async function waitForSocket(socketPath, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 100);
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`socket_not_ready:${socketPath}`);
}

async function rpc(socketPath, command, timeoutMs = 5000) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      reject(new Error("rpc_timeout"));
    }, timeoutMs);
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        const payload = JSON.parse(line);
        if (payload?.type === "response" && payload?.id === command.id) {
          clearTimeout(timer);
          try {
            socket.destroy();
          } catch {
            // ignore
          }
          resolve(payload);
          return;
        }
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(`${JSON.stringify(command)}\n`);
  });
}

function spawnDaemon(agentDir, socketPath, workerPath) {
  return spawn(
    process.execPath,
    [path.join(rootDir, "dist", "core", "rin-daemon", "daemon.js"), socketPath],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        RIN_DIR: agentDir,
        RIN_WORKER_PATH: workerPath,
        RIN_DAEMON_SHUTDOWN_GRACE_MS: "200",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

test("daemon auto-resumes interrupted sessions on startup without frontend help", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-resume-"),
  );
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.mjs");
  await fs.writeFile(
    workerPath,
    `
import process from "node:process";
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "new_session") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile: "/tmp/fake-session.jsonl", sessionId: "fake-session" } });
      continue;
    }
    if (command.type === "switch_session") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { cancelled: false } });
      continue;
    }
    if (command.type === "prompt") {
      send({ type: "agent_start" });
      continue;
    }
    if (command.type === "resume_interrupted_turn") {
      send({ type: "agent_start" });
      continue;
    }
    send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
  }
});
`,
  );

  let daemon = spawnDaemon(agentDir, socketPath, workerPath);
  try {
    await waitForSocket(socketPath);
    const socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({ id: "1", type: "new_session" })}\n`);
    await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(new Error("payload_timeout")),
        5000,
      );
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        while (true) {
          const idx = buffer.indexOf("\n");
          if (idx < 0) break;
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.trim()) continue;
          const payload = JSON.parse(line);
          if (payload?.type === "response" && payload?.id === "1") {
            socket.write(
              `${JSON.stringify({ id: "2", type: "prompt", message: "hello" })}\n`,
            );
          }
          if (payload?.type === "agent_start") {
            clearTimeout(timer);
            resolve();
            return;
          }
        }
      });
    });

    const exited = new Promise((resolve, reject) => {
      daemon.once("exit", (code, signal) => resolve({ code, signal }));
      daemon.once("error", reject);
    });
    daemon.kill("SIGTERM");
    await exited;

    daemon = spawnDaemon(agentDir, socketPath, workerPath);
    await waitForSocket(socketPath);
    let status;
    for (let i = 0; i < 20; i += 1) {
      status = await rpc(socketPath, { id: `3-${i}`, type: "daemon_status" });
      const workers = status.data?.workers || [];
      if (workers.length === 1 && workers[0].isStreaming === true) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const workers = status.data?.workers || [];

    assert.equal(status.success, true);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].sessionFile, "/tmp/fake-session.jsonl");
    assert.equal(workers[0].attachedConnections, 0);
    assert.equal(workers[0].isStreaming, true);
  } finally {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
