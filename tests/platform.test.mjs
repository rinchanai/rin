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
const fsMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "platform", "fs.js")).href
);
const processMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "platform", "process.js"))
    .href
);
const textUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "text-utils.js")).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-platform-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("platform/fs writeJsonAtomic and readJsonFile roundtrip", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "nested", "state.json");
    fsMod.writeJsonAtomic(filePath, { ok: true, count: 2 });
    const parsed = fsMod.readJsonFile(filePath, null);
    assert.deepEqual(parsed, { ok: true, count: 2 });
  });
});

test("platform/fs writeJsonFile writes pretty JSON with trailing newline", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "nested", "config.json");
    fsMod.writeJsonFile(filePath, { ok: true });
    assert.equal(
      await fs.readFile(filePath, "utf8"),
      '{\n  "ok": true\n}\n',
    );
  });
});

test("platform/process helpers behave as expected", async () => {
  assert.equal(processMod.safeString, textUtils.safeString);
  assert.equal(processMod.safeString(null), "");
  assert.equal(processMod.safeString(42), "42");
  assert.equal(processMod.isPidAlive(process.pid), true);
  assert.equal(processMod.isPidAlive(-1), false);
  const started = Date.now();
  await processMod.sleep(20);
  assert.ok(Date.now() - started >= 10);
});
