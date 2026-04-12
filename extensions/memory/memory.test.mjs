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
        content: [
          { type: "text", text: "Does Rin keep raw conversation transcripts?" },
        ],
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
        content: [
          { type: "text", text: "Does Rin keep raw conversation transcripts?" },
        ],
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
          {
            type: "thinking",
            thinking: "Need to inspect the repo before editing.",
          },
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
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:24.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "browser_click",
            args: { selector: "Next" },
          },
          { type: "text", text: "卡在验证码页面，下一步要收验证码。" },
        ],
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
    assert.match(results[0].preview, /browser_click/);
    assert.match(results[0].preview, /验证码/);
    assert.doesNotMatch(results[0].preview, /tool output should not replace/);
    assert.equal(results[1].sessionId, "session-1");
  });
});

test("memory search tolerates duplicate archived transcript ids", async () => {
  await withTempRoot(async (root) => {
    const filePath = transcripts.getTranscriptArchivePath(
      {
        timestamp: "2026-04-05T12:22:22.000Z",
        sessionId: "session-dup",
      },
      root,
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          id: "dup-entry",
          timestamp: "2026-04-05T12:22:22.000Z",
          sessionId: "session-dup",
          sessionFile: "/tmp/session-dup.jsonl",
          role: "assistant",
          text: "first duplicate transcript row",
        }),
        JSON.stringify({
          id: "dup-entry",
          timestamp: "2026-04-05T12:22:23.000Z",
          sessionId: "session-dup",
          sessionFile: "/tmp/session-dup.jsonl",
          role: "assistant",
          text: "latest duplicate transcript row survives search",
        }),
      ].join("\n") + "\n",
    );

    const results = await transcripts.searchTranscriptArchive(
      "latest duplicate transcript row",
      { limit: 8 },
      root,
    );
    assert.equal(results.length, 1);
    assert.match(results[0].preview, /latest duplicate transcript row/);
  });
});

test("memory derives task anchors for actionable blocked steps", async () => {
  await withTempRoot(async (root) => {
    const message = {
      id: "assistant-1",
      timestamp: "2026-04-05T12:22:24.000Z",
      sessionId: "session-anchor",
      sessionFile: "/tmp/session-anchor.jsonl",
      role: "assistant",
      toolName: "browser_click",
      content: [
        {
          type: "toolCall",
          name: "browser_click",
          args: { selector: "Continue with Google" },
        },
        {
          type: "text",
          text: "GitHub signup 卡在验证码页面，下一步要收验证码。",
        },
      ],
    };
    await transcripts.appendTranscriptArchiveEntry(message, root);
    await transcripts.appendTaskAnchorArchiveEntry(message, root);

    const entries = await transcripts.loadTranscriptSessionEntries(
      { sessionId: "session-anchor" },
      root,
    );
    assert.equal(entries.length, 2);
    const anchor = entries.find((entry) => entry.customType === "task_anchor");
    assert.ok(anchor);
    assert.match(anchor.text, /blocked \| assistant \| browser_click/);
    assert.match(anchor.text, /验证码/);

    const results = await transcripts.searchTranscriptArchive(
      "session-anchor 验证码",
      { limit: 8 },
      root,
    );
    assert.equal(results[0].role, "custom");
    assert.match(results[0].preview, /task_anchor/);
  });
});

test("memory recent preview prefers task anchors over generic chatter", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:20.000Z",
        sessionId: "session-preview-anchor",
        sessionFile: "/tmp/session-preview-anchor.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "好的，我继续看看。" }],
      },
      root,
    );
    await transcripts.appendTaskAnchorArchiveEntry(
      {
        id: "assistant-2",
        timestamp: "2026-04-05T12:22:24.000Z",
        sessionId: "session-preview-anchor",
        sessionFile: "/tmp/session-preview-anchor.jsonl",
        role: "assistant",
        toolName: "browser_open",
        content: [
          {
            type: "toolCall",
            name: "browser_open",
            args: { url: "https://accounts.google.com/signup" },
          },
          {
            type: "text",
            text: "已打开 Google 注册页，下一步填写姓名和生日。",
          },
        ],
      },
      root,
    );

    const results = await transcripts.loadRecentTranscriptSessions(
      { limit: 1 },
      root,
    );
    assert.equal(results[0].sessionId, "session-preview-anchor");
    assert.equal(results[0].taskState.status, "next");
    assert.match(results[0].preview, /Next:/);
    assert.match(results[0].preview, /填写姓名和生日/);
  });
});

test("memory derives session task state even when old sessions only have raw transcript rows", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:21.000Z",
        sessionId: "session-old-raw",
        sessionFile: "/tmp/session-old-raw.jsonl",
        role: "assistant",
        toolName: "browser_open",
        content: [
          {
            type: "toolCall",
            name: "browser_open",
            args: { url: "https://github.com/signup" },
          },
          {
            type: "text",
            text: "GitHub 注册卡在验证码页面，下一步等待邮箱验证码。",
          },
        ],
      },
      root,
    );

    const results = await transcripts.loadRecentTranscriptSessions(
      { limit: 1 },
      root,
    );
    assert.equal(results[0].sessionId, "session-old-raw");
    assert.equal(results[0].taskState.status, "blocked");
    assert.match(results[0].preview, /Blocked:/);
    assert.match(results[0].preview, /验证码/);
    assert.match(results[0].preview, /Next:/);
  });
});

test("memory persists structured task state snapshots for sessions", async () => {
  await withTempRoot(async (root) => {
    const message = {
      timestamp: "2026-04-05T12:22:21.000Z",
      sessionId: "session-task-state",
      sessionFile: "/tmp/session-task-state.jsonl",
      role: "assistant",
      toolName: "browser_open",
      content: [
        {
          type: "toolCall",
          name: "browser_open",
          args: { url: "https://github.com/signup" },
        },
        {
          type: "text",
          text: "GitHub 注册卡在验证码页面，下一步等待邮箱验证码。",
        },
      ],
    };
    await transcripts.appendTranscriptArchiveEntry(message, root);
    await transcripts.appendTaskAnchorArchiveEntry(message, root);

    const snapshot = await transcripts.persistTranscriptTaskState(
      { sessionId: "session-task-state" },
      root,
    );
    assert.ok(snapshot);
    assert.equal(snapshot.status, "blocked");
    assert.match(
      snapshot.path,
      /memory[\\/]task-state[\\/]2026[\\/]04[\\/]session-task-state\.json$/,
    );

    const saved = JSON.parse(await fs.readFile(snapshot.path, "utf8"));
    assert.equal(saved.sessionId, "session-task-state");
    assert.equal(saved.status, "blocked");
    assert.ok(Array.isArray(saved.next));
    assert.match(saved.next.join("\n"), /下一步/);
  });
});
