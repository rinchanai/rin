import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const relevance = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "memory", "relevance.js"),
  ).href
);
const compile = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "memory", "compile.js"),
  ).href
);

test("memory relevance scores docs and relations", () => {
  const docA = {
    id: "a",
    name: "SearXNG search",
    description: "search stack searxng",
    content: "Use SearXNG search adapter",
    memory_prompt_slot: "",
    scope: "project",
    kind: "knowledge",
    tags: ["search"],
    aliases: [],
    exposure: "memory_docs",
    status: "active",
    canonical: false,
  };
  const docB = {
    ...docA,
    id: "b",
    name: "Search notes",
    content: "SearXNG tuning notes",
    description: "Use SearXNG",
  };
  assert.ok(relevance.lexicalScore("searxng", docA) > 0);
  assert.ok(relevance.relationScore(docA, docB).score > 0);
  assert.equal(relevance.shouldInjectRecentHistory("最近发生了什么"), true);
});

test("memory compile renders memory prompts and memory docs", () => {
  const docs = [
    {
      id: "voice",
      name: "Voice",
      description: "",
      content: "简洁自然",
      memory_prompt_slot: "core_voice_style",
      scope: "global",
      kind: "preference",
      tags: [],
      aliases: [],
      triggers: [],
      exposure: "memory_prompts",
      fidelity: "exact",
      status: "active",
      canonical: true,
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "search-note",
      name: "Search note",
      description: "Use SearXNG",
      content: "Keep SearXNG design.",
      memory_prompt_slot: "",
      scope: "project",
      kind: "knowledge",
      tags: ["search"],
      aliases: [],
      exposure: "memory_docs",
      fidelity: "fuzzy",
      status: "active",
      canonical: false,
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  const out = compile.compileFromDocsAndEvents(
    docs,
    [],
    { updated_at: "", edges: [] },
    { query: "searxng" },
    "/tmp/memory",
  );
  assert.ok(out.memory_prompt_context.includes("[core_voice_style] 简洁自然"));
  assert.ok(out.memory_doc_context.includes("Search note"));
});
