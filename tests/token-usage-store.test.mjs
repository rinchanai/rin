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
const store = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "token-usage", "store.js")).href,
);

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-token-usage-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("token usage store aggregates by session and capability", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-1",
        timestamp: "2026-04-10T10:00:00.000Z",
        sessionId: "s1",
        sessionName: "chat-1",
        eventType: "message_end",
        messageRole: "assistant",
        provider: "openai-codex",
        model: "gpt-5.4",
        capabilityKind: "assistant_tool_call",
        capabilityKey: "tool:read",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        costTotal: 0.12,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-2",
        timestamp: "2026-04-10T10:05:00.000Z",
        sessionId: "s2",
        sessionName: "chat-2",
        eventType: "message_end",
        messageRole: "assistant",
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        capabilityKind: "assistant_text",
        capabilityKey: "assistant:text",
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: 50,
        costTotal: 0.05,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-3",
        timestamp: "2026-04-10T10:06:00.000Z",
        sessionId: "s2",
        eventType: "tool_execution_end",
        toolName: "read",
        capabilityKind: "tool_execution",
        capabilityKey: "tool:read",
      },
      root,
    );

    const bySession = store.queryTokenUsageAggregate({
      agentDir: root,
      groupBy: ["session_id"],
      limit: 10,
    });
    assert.equal(bySession.length, 2);
    assert.equal(bySession[0].session_id, "s1");
    assert.equal(bySession[0].total_tokens, 120);
    assert.equal(bySession[1].session_id, "s2");
    assert.equal(bySession[1].total_tokens, 50);

    const byCapability = store.queryTokenUsageAggregate({
      agentDir: root,
      groupBy: ["capability"],
      limit: 10,
      includeZero: true,
    });
    assert.equal(byCapability[0].capability, "tool:read");
    assert.equal(byCapability[0].total_tokens, 120);
    assert.equal(byCapability[0].rows, 2);

    const overview = store.getTokenUsageOverview({ agentDir: root });
    assert.equal(overview.total_events, 3);
    assert.equal(overview.token_events, 2);
    assert.equal(overview.total_tokens, 170);
    assert.equal(overview.session_count, 2);
  });
});

test("token usage store ignores duplicate event ids", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-dup",
        timestamp: "2026-04-10T09:00:00.000Z",
        sessionId: "s1",
        eventType: "session_start",
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-dup",
        timestamp: "2026-04-10T09:00:01.000Z",
        sessionId: "s1",
        eventType: "session_start",
      },
      root,
    );

    const rows = store.queryTokenUsageEvents({ agentDir: root, limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, "session_start");
  });
});

test("token usage store returns recent events in reverse time order", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-a",
        timestamp: "2026-04-10T09:00:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        capabilityKey: "assistant:text",
        totalTokens: 10,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-b",
        timestamp: "2026-04-10T09:10:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        capabilityKey: "tool:read",
        totalTokens: 20,
      },
      root,
    );

    const rows = store.queryTokenUsageEvents({ agentDir: root, limit: 10 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].total_tokens, 20);
    assert.equal(rows[1].total_tokens, 10);
  });
});
