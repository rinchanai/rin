import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendSessionTurnState,
  initializeTerminalTurnStateBaseline,
  listInterruptedTurnSessionFiles,
  readSessionTurnState,
  shouldResumeInterruptedTurn,
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
    assert.equal(shouldResumeInterruptedTurn(sessionFile), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("session turn state treats missing, active, or post-terminal user tails as interrupted turns", async () => {
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

    assert.deepEqual(listInterruptedTurnSessionFiles(dir), [
      active,
      completedWithUserTail,
      unmarked,
    ]);
    assert.equal(
      shouldResumeInterruptedTurn(completedWithAssistantTail),
      false,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("terminal turn state baseline leaves legacy sessions recoverable without mutating logs", async () => {
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

    const baselineTimestamp = initializeTerminalTurnStateBaseline(
      path.dirname(legacy),
      baselineFile,
    );

    assert.equal(readSessionTurnState(legacy), undefined);
    assert.equal(readSessionTurnState(active)?.status, "active");
    assert.deepEqual(listInterruptedTurnSessionFiles(path.dirname(legacy)), [
      active,
      legacy,
    ]);
    assert.deepEqual(
      listInterruptedTurnSessionFiles(path.dirname(legacy), {
        terminalBaselineTimestamp: baselineTimestamp,
      }),
      [active],
    );

    const legacyBefore = await fs.readFile(legacy, "utf8");
    assert.equal(
      initializeTerminalTurnStateBaseline(path.dirname(legacy), baselineFile),
      baselineTimestamp,
    );
    assert.equal(await fs.readFile(legacy, "utf8"), legacyBefore);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("terminal turn state baseline preserves unmarked interrupted turns", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-state-"));
  try {
    const baselineFile = path.join(dir, "data", "baseline.json");
    const sessionsDir = path.join(dir, "sessions");
    const assistantToolCall = path.join(
      sessionsDir,
      "assistant-tool-call.jsonl",
    );
    const toolResultTail = path.join(sessionsDir, "tool-result-tail.jsonl");
    const userTail = path.join(sessionsDir, "user-tail.jsonl");
    const completed = path.join(sessionsDir, "completed.jsonl");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      assistantToolCall,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "run tool" },
          id: "u1",
          parentId: null,
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-1", name: "bash" }],
          },
          id: "a1",
          parentId: "u1",
        }),
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      toolResultTail,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-2", name: "read" }],
          },
          id: "a2",
          parentId: null,
        }),
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolCallId: "tool-2", content: [] },
          id: "t2",
          parentId: "a2",
        }),
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      userTail,
      `${JSON.stringify({ type: "message", message: { role: "user", content: "continue" }, id: "u3", parentId: null })}\n`,
    );
    await fs.writeFile(
      completed,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: "done" }, id: "a4", parentId: null })}\n`,
    );

    const baselineTimestamp = initializeTerminalTurnStateBaseline(
      sessionsDir,
      baselineFile,
    );

    assert.equal(readSessionTurnState(assistantToolCall), undefined);
    assert.equal(readSessionTurnState(toolResultTail), undefined);
    assert.equal(readSessionTurnState(userTail), undefined);
    assert.equal(readSessionTurnState(completed), undefined);
    assert.deepEqual(
      listInterruptedTurnSessionFiles(sessionsDir, {
        terminalBaselineTimestamp: baselineTimestamp,
      }),
      [assistantToolCall, toolResultTail, userTail],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("terminal turn state baseline ignores malformed lines when classifying legacy tails", async () => {
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

    const legacyBefore = await fs.readFile(legacy, "utf8");
    const baselineTimestamp = initializeTerminalTurnStateBaseline(
      path.dirname(legacy),
      baselineFile,
    );

    assert.equal(await fs.readFile(legacy, "utf8"), legacyBefore);
    assert.deepEqual(
      listInterruptedTurnSessionFiles(path.dirname(legacy), {
        terminalBaselineTimestamp: baselineTimestamp,
      }),
      [],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("terminal baseline markers classify by the previous session tail", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-state-"));
  try {
    const completed = path.join(dir, "completed.jsonl");
    const interrupted = path.join(dir, "interrupted.jsonl");
    const baselineEntry = {
      type: "custom",
      customType: "rin-turn-state",
      data: {
        status: "completed",
        timestamp: "2026-04-24T00:00:00.000Z",
        reason: "terminal-state-baseline",
      },
    };
    await fs.writeFile(
      completed,
      [
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "done" },
        }),
        JSON.stringify(baselineEntry),
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      interrupted,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-1", name: "bash" }],
          },
        }),
        JSON.stringify(baselineEntry),
        "",
      ].join("\n"),
    );

    assert.equal(shouldResumeInterruptedTurn(completed), false);
    assert.equal(shouldResumeInterruptedTurn(interrupted), true);
    assert.deepEqual(listInterruptedTurnSessionFiles(dir), [interrupted]);
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
