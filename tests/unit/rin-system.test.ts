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
const hiddenSession = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin", "hidden-session.js"),
  ).href,
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-hidden-session-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("sanitizeHiddenSessionName accepts simple session names", () => {
  assert.equal(hiddenSession.sanitizeHiddenSessionName("demo-1"), "demo-1");
});

test("sanitizeHiddenSessionName rejects unsafe names", () => {
  assert.throws(
    () => hiddenSession.sanitizeHiddenSessionName("../demo"),
    /rin_hidden_session_name_invalid/,
  );
});

test("listHiddenSessions keeps usable sessions and prunes stale ones", async () => {
  await withTempDir(async (agentDir) => {
    const root = hiddenSession.hiddenSessionStateRoot(agentDir);
    await fs.mkdir(root, { recursive: true });

    const aliveState = {
      name: "alive",
      mode: "rpc",
      pid: process.pid,
      socketPath: hiddenSession.hiddenSessionSocketPath("alive"),
      statePath: hiddenSession.hiddenSessionStatePath(agentDir, "alive"),
      createdAt: new Date().toISOString(),
      repoRoot: "/repo",
      agentDir,
      passthrough: [],
    };
    await fs.mkdir(path.dirname(aliveState.socketPath), { recursive: true });
    await fs.writeFile(aliveState.socketPath, "", "utf8");
    await fs.writeFile(
      aliveState.statePath,
      `${JSON.stringify(aliveState, null, 2)}\n`,
      "utf8",
    );

    const staleState = {
      ...aliveState,
      name: "stale",
      pid: 999999,
      socketPath: hiddenSession.hiddenSessionSocketPath("stale"),
      statePath: hiddenSession.hiddenSessionStatePath(agentDir, "stale"),
    };
    await fs.writeFile(
      staleState.statePath,
      `${JSON.stringify(staleState, null, 2)}\n`,
      "utf8",
    );

    const rows = hiddenSession.listHiddenSessions(agentDir);
    assert.deepEqual(rows.map((row) => row.name), ["alive"]);
    await fs.access(aliveState.statePath);
    await assert.rejects(fs.access(staleState.statePath));
  });
});
