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

test("session turn state treats missing, active, or post-terminal user tails as resumable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-state-"));
  try {
    const unmarked = path.join(dir, "unmarked.jsonl");
    const active = path.join(dir, "active.jsonl");
    const completed = path.join(dir, "completed.jsonl");
    const completedWithAssistantTail = path.join(
      dir,
      "completed-with-assistant-tail.jsonl",
    );
    const completedWithUserTail = path.join(
      dir,
      "completed-with-user-tail.jsonl",
    );
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
    await fs.writeFile(
      completedWithAssistantTail,
      [
        JSON.stringify({
          type: "custom",
          customType: "rin-turn-state",
          data: { status: "completed" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "done" },
        }),
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      completedWithUserTail,
      [
        JSON.stringify({
          type: "custom",
          customType: "rin-turn-state",
          data: { status: "completed" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "done" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "continue" },
        }),
        "",
      ].join("\n"),
    );

    assert.deepEqual(listResumableSessionFiles(dir), [
      active,
      completedWithUserTail,
      unmarked,
    ]);
    assert.equal(shouldResumeSessionFile(completedWithAssistantTail), false);
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

test("terminal turn state baseline ignores malformed lines while preserving the latest valid parent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-state-"));
  try {
    const baselineFile = path.join(dir, "data", "baseline.json");
    const legacy = path.join(dir, "sessions", "legacy.jsonl");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(
      legacy,
      [
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "done" },
          id: "a1",
          parentId: null,
        }),
        "{not-json}",
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "later" },
          id: "a2",
          parentId: "a1",
        }),
        "",
      ].join("\n"),
    );

    initializeTerminalTurnStateBaseline(path.dirname(legacy), baselineFile);

    const entries = (await fs.readFile(legacy, "utf8"))
      .trim()
      .split(/\r?\n/g)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const appended = entries.at(-1);
    assert.equal(appended.customType, "rin-turn-state");
    assert.equal(appended.data.status, "completed");
    assert.equal(appended.parentId, "a2");
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
