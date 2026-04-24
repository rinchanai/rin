import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);

function createSession(id: string) {
  return {
    sessionManager: {
      getSessionId() {
        return id;
      },
    },
  };
}

test("compaction continuation markers fall back when the preferred temp root is unusable", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-compaction-continuation-fallback-"),
  );
  const blocker = path.join(tempRoot, "blocked-root");
  const previousRinTmpDir = process.env.RIN_TMP_DIR;

  try {
    await fs.writeFile(blocker, "not a directory", "utf8");
    process.env.RIN_TMP_DIR = path.join(blocker, "nested");

    const session = createSession(`session-fallback-${process.pid}`);
    runtimeMod.clearCompactionContinuationMarker(session);

    runtimeMod.writeCompactionContinuationMarker(session, {
      reason: "overflow",
      assistantPreview: "continue after overflow",
    });

    const marker = runtimeMod.consumeCompactionContinuationMarker(session);
    assert.equal(marker?.reason, "overflow");
    assert.equal(marker?.assistantPreview, "continue after overflow");
    assert.equal(
      runtimeMod.consumeCompactionContinuationMarker(session),
      undefined,
    );
  } finally {
    if (previousRinTmpDir == null) delete process.env.RIN_TMP_DIR;
    else process.env.RIN_TMP_DIR = previousRinTmpDir;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
