import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendSessionTurnState,
  initializeTerminalTurnStateBaseline,
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

test("session turn state treats missing or active markers as resumable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-state-"));
  try {
    const unmarked = path.join(dir, "unmarked.jsonl");
    const active = path.join(dir, "active.jsonl");
    const completed = path.join(dir, "completed.jsonl");
    await fs.writeFile(
      unmarked,
      `${JSON.stringify({ type: "message", message: { role: "user", content: "hello" }, id: "u1", parentId: null })}\n`,
    );
    await fs.writeFile(
      active,
      `${JSON.stringify({ type: "custom", customType: "rin-turn-state", data: { status: "active" } })}\n`,
    );
    await fs.writeFile(
      completed,
      `${JSON.stringify({ type: "custom", customType: "rin-turn-state", data: { status: "completed" } })}\n`,
    );

    assert.deepEqual(listResumableSessionFiles(dir), [active, unmarked]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("terminal turn state baseline marks legacy untracked sessions completed once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-state-"));
  try {
    const baselineFile = path.join(dir, "data", "baseline.json");
    const legacy = path.join(dir, "sessions", "legacy.jsonl");
    const active = path.join(dir, "sessions", "active.jsonl");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(
      legacy,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: "done" }, id: "a1", parentId: null })}\n`,
    );
    await fs.writeFile(
      active,
      `${JSON.stringify({ type: "custom", customType: "rin-turn-state", data: { status: "active" }, id: "c1", parentId: null })}\n`,
    );

    initializeTerminalTurnStateBaseline(path.dirname(legacy), baselineFile);

    assert.equal(readSessionTurnState(legacy)?.status, "completed");
    assert.equal(readSessionTurnState(active)?.status, "active");
    assert.deepEqual(listResumableSessionFiles(path.dirname(legacy)), [active]);

    const legacyBefore = await fs.readFile(legacy, "utf8");
    initializeTerminalTurnStateBaseline(path.dirname(legacy), baselineFile);
    assert.equal(await fs.readFile(legacy, "utf8"), legacyBefore);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("appendSessionTurnState writes compact terminal custom session entries", () => {
  const entries: any[] = [];
  appendSessionTurnState(
    {
      sessionManager: {
        appendCustomEntry: (customType: string, data: unknown) =>
          entries.push({ customType, data }),
      },
    },
    "completed",
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].customType, "rin-turn-state");
  assert.equal(entries[0].data.status, "completed");
  assert.match(entries[0].data.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
