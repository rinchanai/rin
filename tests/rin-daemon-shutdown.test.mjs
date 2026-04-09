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
        } catch {}
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

test("daemon exits promptly on SIGTERM even with connected rpc clients", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-daemon-stop-"));
  const socketPath = path.join(agentDir, "daemon.sock");
  const child = spawn(
    process.execPath,
    [path.join(rootDir, "dist", "core", "rin-daemon", "daemon.js"), socketPath],
    {
      cwd: rootDir,
      env: { ...process.env, RIN_DIR: agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForSocket(socketPath);
    const client = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });

    const exited = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });

    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("daemon_exit_timeout")), 3000),
      ),
    ]);

    assert.equal(
      result.code === 0 || result.signal === "SIGTERM",
      true,
      JSON.stringify(result),
    );
    assert.equal(client.destroyed, true);
  } catch (error) {
    throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
