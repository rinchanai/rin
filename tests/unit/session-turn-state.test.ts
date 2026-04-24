import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendSessionTurnState,
  listResumableSessionFiles,
  readSessionTurnState,
  shouldResumeSessionFile,
} from "../../src/core/session/turn-state.js";

test("session turn state uses the latest durable marker", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-state-"));
  try {
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "custom",
          customType: "rin-turn-state",
          data: { status: "active", timestamp: "1" },
        }),
        JSON.stringify({
          type: "custom",
          customType: "rin-turn-state",
          data: { status: "completed", timestamp: "2" },
        }),
        "",
      ].join("\n"),
    );

    assert.deepEqual(readSessionTurnState(sessionFile), {
      status: "completed",
      timestamp: "2",
    });
    assert.equal(shouldResumeSessionFile(sessionFile), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("session turn state scanner resumes every active session recursively", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-state-"));
  try {
    const activeRoot = path.join(dir, "active.jsonl");
    const activeNested = path.join(dir, "managed", "task", "active.jsonl");
    const aborted = path.join(dir, "aborted.jsonl");
    await fs.mkdir(path.dirname(activeNested), { recursive: true });
    await fs.writeFile(
      activeRoot,
      `${JSON.stringify({ type: "custom", customType: "rin-turn-state", data: { status: "active" } })}\n`,
    );
    await fs.writeFile(
      activeNested,
      `${JSON.stringify({ type: "custom", customType: "rin-turn-state", data: { status: "active" } })}\n`,
    );
    await fs.writeFile(
      aborted,
      `${JSON.stringify({ type: "custom", customType: "rin-turn-state", data: { status: "aborted" } })}\n`,
    );

    assert.deepEqual(listResumableSessionFiles(dir), [
      activeRoot,
      activeNested,
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("appendSessionTurnState writes compact custom session entries", () => {
  const entries: any[] = [];
  appendSessionTurnState(
    {
      sessionManager: {
        appendCustomEntry: (customType: string, data: unknown) =>
          entries.push({ customType, data }),
      },
    },
    "active",
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].customType, "rin-turn-state");
  assert.equal(entries[0].data.status, "active");
  assert.match(entries[0].data.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
