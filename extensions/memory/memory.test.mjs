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
const transcripts = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "memory", "transcripts.js"),
  ).href
);

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-memory-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("memory transcripts archive entries under memory/transcripts", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        role: "user",
        content: [{ type: "text", text: "Does Rin keep raw conversation transcripts?" }],
      },
      root,
    );

    const sessionPath = transcripts.getTranscriptArchivePath(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
      },
      root,
    );
    assert.match(
      sessionPath,
      /memory[\\/]transcripts[\\/]2026[\\/]04[\\/]session-1\.jsonl$/,
    );
  });
});

test("memory search returns archived transcript matches", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        role: "user",
        content: [{ type: "text", text: "Does Rin keep raw conversation transcripts?" }],
      },
      root,
    );

    const results = await transcripts.searchTranscriptArchive(
      "raw conversation transcripts",
      { limit: 8 },
      root,
    );
    assert.ok(Array.isArray(results));
    assert.equal(results[0].sourceType, "transcript");
    assert.match(results[0].path, /2026[\\/]04[\\/]session-1\.jsonl$/);
    assert.match(results[0].preview, /raw conversation transcripts/);
  });
});

test("memory transcripts preserve assistant tool calls and thinking for recall", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need to inspect the repo before editing." },
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            args: { path: "/tmp/demo.txt" },
          },
          { type: "text", text: "I checked the file and found the setting." },
        ],
      },
      root,
    );

    const byTool = await transcripts.searchTranscriptArchive(
      "read /tmp/demo.txt",
      { limit: 8 },
      root,
    );
    assert.equal(byTool[0].role, "assistant");
    assert.match(byTool[0].preview, /tool:read/);
    assert.match(byTool[0].preview, /demo\.txt/);

    const entries = await transcripts.loadTranscriptSessionEntries(
      { sessionId: "session-2" },
      root,
    );
    assert.equal(entries.length, 1);
    assert.match(entries[0].text, /Need to inspect the repo/);
    assert.match(entries[0].text, /tool:read/);
  });
});


test("memory can browse recent sessions without a query", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "这是较早的一次会话" }],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:22.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "user",
        content: [{ type: "text", text: "这是最近的一次会话" }],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:23.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "toolResult",
        toolName: "read",
        content: "tool output should not replace the session preview",
      },
      root,
    );

    const results = await transcripts.loadRecentTranscriptSessions(
      { limit: 2 },
      root,
    );
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 2);
    assert.equal(results[0].sourceType, "session");
    assert.equal(results[0].sessionId, "session-2");
    assert.match(results[0].preview, /最近/);
    assert.equal(results[1].sessionId, "session-1");
  });
});
