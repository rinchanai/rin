import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const search = await import(
  pathToFileURL(path.join(rootDir, "dist", "extensions", "memory", "search.js"))
    .href
);

test("memory search query builder stays thin and preserves the query", () => {
  const query = search.buildSearchQuery(
    "  搜索记忆 过程 searchMemories lexicalScore memory.search read 当前实现 Rin memory  ",
  );
  assert.equal(
    query,
    "搜索记忆 过程 searchMemories lexicalScore memory.search read 当前实现 Rin memory",
  );
});

test("memory search delegates ranking to MiniSearch and returns the best match first", () => {
  const docs = [
    {
      id: "reconnect-flicker",
      title: "Reconnect flicker fix",
      exposure: "recall",
      fidelity: "fuzzy",
      resident_slot: "",
      summary: "TUI reconnect flicker fix history",
      tags: ["tui", "reconnect"],
      aliases: [],
      triggers: ["reconnect flicker"],
      scope: "project",
      kind: "history",
      sensitivity: "normal",
      source: "test",
      updated_at: "2026-01-01T00:00:00.000Z",
      last_observed_at: "2026-01-01T00:00:00.000Z",
      observation_count: 1,
      status: "active",
      supersedes: [],
      canonical: false,
      path: "/tmp/reconnect-flicker.md",
      content: "We previously fixed a reconnect flicker in the TUI.",
    },
    {
      id: "generic-process-note",
      title: "Generic process note",
      exposure: "recall",
      fidelity: "fuzzy",
      resident_slot: "",
      summary: "Current implementation process notes",
      tags: ["process"],
      aliases: [],
      triggers: [],
      scope: "project",
      kind: "knowledge",
      sensitivity: "normal",
      source: "test",
      updated_at: "2026-01-01T00:00:00.000Z",
      last_observed_at: "2026-01-01T00:00:00.000Z",
      observation_count: 1,
      status: "active",
      supersedes: [],
      canonical: false,
      path: "/tmp/generic-process-note.md",
      content:
        "This note describes a general process and implementation details.",
    },
  ];

  const results = search.searchMemoryDocs(docs, "reconnect flicker", {
    limit: 8,
  });

  assert.equal(results.length >= 1, true);
  assert.equal(results[0].doc.id, "reconnect-flicker");
});
