import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const service = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-koishi", "service.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rin-koishi-service-"));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function isPidAlive(pid) {
  if (!(Number(pid) > 1)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("koishi service reuses existing live instance state and reports stable status", async () => {
  await withTempDir(async (stateRoot) => {
    const statusBefore = service.getKoishiSidecarStatus(stateRoot);
    assert.equal(
      statusBefore.root,
      path.join(path.resolve(stateRoot), "data", "koishi-sidecar"),
    );
    assert.deepEqual(statusBefore.instances, []);

    const instanceId = "demo";
    const instanceRoot = path.join(
      stateRoot,
      "data",
      "koishi-sidecar",
      "instances",
      instanceId,
    );
    fs.mkdirSync(instanceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(instanceRoot, "state.json"),
      JSON.stringify({
        pid: process.pid,
        ownerPid: process.pid,
        entryPath: "/tmp/koishi-entry.js",
        startedAt: "2026-04-14T08:00:00.000Z",
      }),
    );

    const reused = await service.ensureKoishiSidecar(stateRoot, { instanceId });
    assert.deepEqual(reused, {
      ok: true,
      instanceId,
      pid: process.pid,
      reused: true,
    });

    const statusAfter = service.getKoishiSidecarStatus(stateRoot);
    assert.deepEqual(statusAfter.instances, [
      {
        instanceId,
        pid: process.pid,
        alive: true,
        startedAt: "2026-04-14T08:00:00.000Z",
        ownerPid: process.pid,
        entryPath: "/tmp/koishi-entry.js",
        statePath: path.join(instanceRoot, "state.json"),
      },
    ]);
  });
});

test("koishi service launches a fresh sidecar from an explicit entry path and stops it cleanly", async () => {
  await withTempDir(async (stateRoot) => {
    const scriptPath = path.join(stateRoot, "koishi-child.mjs");
    fs.writeFileSync(
      scriptPath,
      'setInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => process.exit(0));\n',
      "utf8",
    );

    const started = await service.ensureKoishiSidecar(stateRoot, {
      instanceId: "fresh",
      entryPath: scriptPath,
    });
    assert.equal(started.ok, true);
    assert.equal(started.instanceId, "fresh");
    assert.equal(started.reused, false);
    assert.ok(Number(started.pid) > 1);

    const statePath = path.join(
      stateRoot,
      "data",
      "koishi-sidecar",
      "instances",
      "fresh",
      "state.json",
    );
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.entryPath, scriptPath);
    assert.equal(state.ownerPid, process.pid);
    assert.equal(isPidAlive(started.pid), true);

    const stopped = await service.stopKoishiSidecar(stateRoot, {
      instanceId: "fresh",
    });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.pid, started.pid);
    assert.equal(fs.existsSync(path.dirname(statePath)), false);
    await waitForPidExit(started.pid);
  });
});

test("koishi service cleanup removes orphan instance roots and stop rejects missing instance ids", async () => {
  await withTempDir(async (stateRoot) => {
    const instanceRoot = path.join(
      stateRoot,
      "data",
      "koishi-sidecar",
      "instances",
      "orphaned",
    );
    fs.mkdirSync(instanceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(instanceRoot, "state.json"),
      JSON.stringify({ pid: 0, ownerPid: 999999, startedAt: "old" }),
    );

    const cleaned = await service.cleanupOrphanKoishiSidecars(stateRoot);
    assert.deepEqual(cleaned, {
      ok: true,
      cleaned: [{ instanceId: "orphaned", pid: 0, ownerPid: 999999 }],
    });
    assert.equal(fs.existsSync(instanceRoot), false);

    assert.deepEqual(await service.stopKoishiSidecar(stateRoot), {
      ok: false,
      error: "koishi_instance_required",
    });
  });
});
