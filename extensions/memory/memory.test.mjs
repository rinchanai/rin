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
  ).href,
);
const memoryExtensionModule = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "memory", "index.js"),
  ).href,
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

test("memory search returns session-level archived transcript matches and creates persistent index", async () => {
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
    assert.equal(results[0].sourceType, "session");
    assert.equal(results[0].sessionId, "session-1");
    assert.match(results[0].path, /2026[\\/]04[\\/]session-1\.jsonl$/);
    assert.match(results[0].preview, /raw conversation transcripts/);
    assert.equal(results[0].hitCount, 1);

    const searchDbPath = path.join(root, "memory", "search.db");
    await assert.doesNotReject(() => fs.access(searchDbPath));
  });
});

test("memory search index stays in sync when an archived session file grows", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-sync",
        sessionFile: "/tmp/session-sync.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "first alpha result" }],
      },
      root,
    );

    const first = await transcripts.searchTranscriptArchive("alpha", { limit: 8 }, root);
    assert.equal(first.length, 1);
    assert.equal(first[0].hitCount, 1);

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:12.000Z",
        sessionId: "session-sync",
        sessionFile: "/tmp/session-sync.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "second beta result" }],
      },
      root,
    );

    const second = await transcripts.searchTranscriptArchive("beta", { limit: 8 }, root);
    assert.equal(second.length, 1);
    assert.equal(second[0].sessionId, "session-sync");
    assert.equal(second[0].hitCount, 1);
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
    assert.equal(byTool[0].sessionId, "session-2");
    assert.match(byTool[0].preview, /tool:read/);
    assert.match(byTool[0].preview, /demo\.txt/);
    assert.ok(Array.isArray(byTool[0].matchedEntries));
    assert.match(byTool[0].matchedEntries[0].preview, /demo\.txt/);

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:12:11.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "Updated the same session with a follow-up note about retries." }],
      },
      root,
    );
    const followUp = await transcripts.searchTranscriptArchive(
      "follow-up note retries",
      { limit: 8 },
      root,
    );
    assert.equal(followUp[0].sessionId, "session-2");

    const entries = await transcripts.loadTranscriptSessionEntries(
      { sessionId: "session-2" },
      root,
    );
    assert.equal(entries.length, 2);
    assert.match(entries[0].text, /Need to inspect the repo/);
    assert.match(entries[0].text, /tool:read/);
    assert.match(entries[1].text, /follow-up note about retries/);
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
          { type: "toolCall", name: "browser_click", args: { selector: "Next" } },
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

test("memory search merges multiple message hits from the same session", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T10:00:00.000Z",
        sessionId: "session-a",
        sessionFile: "/tmp/session-a.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "Debugged koishi outbound send routing." }],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T10:01:00.000Z",
        sessionId: "session-a",
        sessionFile: "/tmp/session-a.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "Fixed koishi reply context and outbound send retry." }],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T11:00:00.000Z",
        sessionId: "session-b",
        sessionFile: "/tmp/session-b.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "Looked at unrelated Telegram bridge code." }],
      },
      root,
    );

    const results = await transcripts.searchTranscriptArchive(
      "koishi outbound send",
      { limit: 2 },
      root,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "session-a");
    assert.equal(results[0].hitCount, 2);
    assert.ok(Array.isArray(results[0].matchedEntries));
    assert.equal(results[0].matchedEntries.length, 2);
  });
});

test("memory search handles structured identifiers beyond exact raw substrings", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-07T08:08:08.000Z",
        sessionId: "session-ident",
        sessionFile: "/tmp/session-ident.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "Investigated chat-send.ts for the P2.2 outbound bridge regression." }],
      },
      root,
    );

    const results = await transcripts.searchTranscriptArchive(
      "chat send p2.2",
      { limit: 8 },
      root,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "session-ident");
    assert.match(results[0].preview, /chat-send\.ts/);
    assert.match(results[0].matchedEntries[0].preview, /P2\.2/);
  });
});

test("memory summarization subagent hides the memory extension", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:09:09.000Z",
        sessionId: "session-summary",
        sessionFile: "/tmp/session-summary.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "Refined the memory recall prompt and fixed the session resume hang." }],
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({ auxiliaryModel: { model: "test/demo", thinkingLevel: "low" } }),
      "utf8",
    );

    const rows = await transcripts.searchTranscriptArchive(
      "session resume hang",
      { limit: 8 },
      root,
    );
    const calls = [];
    const summarized = await memoryExtensionModule.maybeSummarizeTranscriptMatches(
      rows,
      "session resume hang",
      { agentDir: root },
      "medium",
      async (options) => {
        calls.push(options);
        return {
          ok: true,
          results: [{ output: "Summarized recall sentence." }],
        };
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.tasks.length, 1);
    assert.deepEqual(calls[0].params.tasks[0].disabledExtensions, ["memory"]);
    assert.equal(calls[0].params.tasks[0].model, "test/demo");
    assert.equal(calls[0].params.tasks[0].thinkingLevel, "low");
    assert.equal(calls[0].ctx.agentDir, root);
    assert.equal(summarized[0].summary, "Summarized recall sentence.");
  });
});


test("search_memory summarization falls back to runtime agent dir and low thinking", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:09:09.000Z",
        sessionId: "session-runtime",
        sessionFile: "/tmp/session-runtime.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "Verified runtime fallback for memory summarization." }],
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({ auxiliaryModel: { model: "test/demo" } }),
      "utf8",
    );

    const rows = await transcripts.searchTranscriptArchive(
      "runtime fallback memory summarization",
      { limit: 8 },
      root,
    );

    const previousRinDir = process.env.RIN_DIR;
    const previousPiDir = process.env.PI_CODING_AGENT_DIR;
    process.env.RIN_DIR = root;
    process.env.PI_CODING_AGENT_DIR = root;

    try {
      const calls = [];
      const summarized = await memoryExtensionModule.maybeSummarizeTranscriptMatches(
        rows,
        "runtime fallback memory summarization",
        {},
        "high",
        async (options) => {
          calls.push(options);
          return {
            ok: true,
            results: [{ output: "Runtime fallback summary." }],
          };
        },
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0].ctx.agentDir, root);
      assert.equal(calls[0].params.tasks[0].thinkingLevel, "low");
      assert.equal(summarized[0].summary, "Runtime fallback summary.");
    } finally {
      if (previousRinDir === undefined) delete process.env.RIN_DIR;
      else process.env.RIN_DIR = previousRinDir;
      if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiDir;
    }
  });
});

test("search_memory fails instead of silently degrading to raw transcript results", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:09:09.000Z",
        sessionId: "session-tool",
        sessionFile: "/tmp/session-tool.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "Fixed search_memory hang by removing nested subagent recall." }],
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({ auxiliaryModel: { model: "test/demo" } }),
      "utf8",
    );

    const rows = await transcripts.searchTranscriptArchive(
      "nested subagent recall",
      { limit: 8 },
      root,
    );
    await assert.rejects(
      () => memoryExtensionModule.maybeSummarizeTranscriptMatches(
        rows,
        "nested subagent recall",
        { agentDir: root },
        "medium",
        async () => ({ ok: false, error: "summary worker unavailable" }),
      ),
      /summary worker unavailable/,
    );
  });
});

test("search_memory formatting shows query and absolute session path", () => {
  const rendered = memoryExtensionModule.formatSearchResult({
    query: "minecraft server",
    results: [
      {
        sessionFile: "/home/rin/.rin/sessions/demo.jsonl",
        path: "/home/rin/.rin/memory/transcripts/2026/04/demo.jsonl",
        summary: "Investigated the Minecraft server modpack crash and identified the failing config file.",
        preview: "raw preview should never leak",
      },
    ],
  });

  assert.match(rendered, /^search_memory minecraft server/m);
  assert.match(rendered, /\/home\/rin\/\.rin\/sessions\/demo\.jsonl/);
  assert.match(rendered, /Investigated the Minecraft server modpack crash/);
  assert.doesNotMatch(rendered, /raw preview should never leak/);
});

test("search_memory agent formatting uses absolute path instead of timestamps", () => {
  const rendered = memoryExtensionModule.formatAgentSearchResult({
    query: "koishi outbound",
    results: [
      {
        timestamp: "2026-04-14T06:05:42.876Z",
        sessionId: "b6745c84-869c-4bc4-9709-9cda7a4f6def",
        sessionFile: "/home/rin/.rin/sessions/2026-04-14T06-05-42-876Z_b6745c84-869c-4bc4-9709-9cda7a4f6def.jsonl",
        path: "/home/rin/.rin/memory/transcripts/2026/04/64ccd205-ea35-4716-b2d4-9eff931eb59c.jsonl",
        summary: "Fixed the Koishi outbound send routing bug and verified the affected bridge path.",
      },
    ],
  });

  assert.match(rendered, /^search_memory koishi outbound \(1\)/m);
  assert.match(
    rendered,
    /1\. \/home\/rin\/\.rin\/sessions\/2026-04-14T06-05-42-876Z_b6745c84-869c-4bc4-9709-9cda7a4f6def\.jsonl/,
  );
  assert.doesNotMatch(rendered, /^1\. 2026-04-14T06:05:42\.876Z/m);
});

test("search_memory call formatting keeps query in the TUI tool title", () => {
  const theme = {
    fg: (_name, value) => value,
    bold: (value) => value,
  };
  const rendered = memoryExtensionModule.formatSearchMemoryCall(
    { query: "search_memory hang" },
    theme,
  );
  assert.equal(rendered, "search_memory search_memory hang");
});
