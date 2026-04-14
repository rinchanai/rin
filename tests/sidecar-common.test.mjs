import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const sidecar = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "sidecar", "common.js")).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-sidecar-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("sidecar common writes, reads and lists instance state", async () => {
  await withTempDir(async (dir) => {
    const instancesRoot = path.join(dir, "instances");
    const statePath = path.join(instancesRoot, "demo", "state.json");
    sidecar.writeInstanceState(statePath, { pid: 123, ownerPid: 456 });
    const state = sidecar.readInstanceState(statePath);
    assert.deepEqual(state, { pid: 123, ownerPid: 456 });
    const ids = sidecar.listInstanceIds(instancesRoot);
    assert.deepEqual(ids, ["demo"]);
  });
});

test("sidecar common acquires and releases process lock", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "demo.lock");
    const release = await sidecar.acquireProcessLock(lockPath, 500);
    const stat = await fs.stat(lockPath);
    assert.ok(stat.isFile());
    release();
    await assert.rejects(fs.stat(lockPath));
  });
});

test("sidecar common clears stale lock files before acquiring the lock", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "stale.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, ts: Date.now() - 60_000 }),
    );

    const release = await sidecar.acquireProcessLock(lockPath, 500);
    const state = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(state.pid, process.pid);
    release();
    await assert.rejects(fs.stat(lockPath));
  });
});
