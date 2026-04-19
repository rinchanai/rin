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
    path.join(rootDir, "dist", "core", "self-improve", "relevance.js"),
  ).href
);
const compile = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "compile.js"),
  ).href
);

function buildDoc(overrides = {}) {
  return {
    id: "a",
    name: "SearXNG search",
    description: "search stack searxng",
    content: "Use SearXNG search adapter",
    self_improve_prompt_slot: "",
    scope: "project",
    kind: "fact",
    tags: ["search"],
    aliases: [],
    exposure: "self_improve_prompts",
    status: "active",
    canonical: false,
    ...overrides,
  };
}

function buildEvent(overrides = {}) {
  return {
    id: "event-1",
    created_at: new Date().toISOString(),
    kind: "tool_result",
    session_id: "session-1",
    session_file: "/tmp/session-1.jsonl",
    chat_key: "",
    source: "test",
    tool_name: "web_search",
    is_error: false,
    summary: "search results arrived",
    text: "SearXNG search adapter updated",
    tags: ["search"],
    ...overrides,
  };
}

test("memory relevance scores docs, events, and relations consistently", () => {
  const docA = buildDoc();
  const docB = buildDoc({
    id: "b",
    name: "Search notes",
    content: "SearXNG tuning notes",
    description: "Use SearXNG",
  });
  const inactiveDoc = buildDoc({ status: "superseded" });
  const chronicleDoc = buildDoc({ tags: ["search", "chronicle"] });
  const recentEvent = buildEvent();
  const staleEvent = buildEvent({
    created_at: new Date(Date.now() - 72 * 3_600_000).toISOString(),
  });

  assert.ok(relevance.lexicalScore("searxng", docA) > 0);
  assert.ok(
    relevance.lexicalScore("searxng", inactiveDoc) <
      relevance.lexicalScore("searxng", docA),
  );
  assert.ok(
    relevance.lexicalScore("search", chronicleDoc) <
      relevance.lexicalScore("search", docA),
  );
  assert.ok(
    relevance.lexicalScore("recent search history", chronicleDoc) > 0,
  );
  assert.ok(
    relevance.eventScore("search", recentEvent) >
      relevance.eventScore("search", staleEvent),
  );
  assert.ok(relevance.relationScore(docA, docB).score > 0);
  assert.equal(relevance.relationScore(docA, docB).reason, "shared-tags");
  assert.equal(relevance.shouldInjectRecentHistory("what happened recently"), true);
  assert.equal(relevance.shouldInjectRecentHistory("why did we roll back"), true);
});

test("self-improve compile renders prompt slots", () => {
  const docs = [
    {
      id: "voice",
      name: "Agent Profile",
      description: "",
      content: "Concise and natural",
      self_improve_prompt_slot: "agent_profile",
      scope: "global",
      kind: "instruction",
      tags: [],
      aliases: [],
      triggers: [],
      exposure: "self_improve_prompts",
      fidelity: "exact",
      status: "active",
      canonical: true,
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "core-facts",
      name: "Core Facts",
      description: "Use SearXNG",
      content: "Keep SearXNG design.",
      self_improve_prompt_slot: "core_facts",
      scope: "global",
      kind: "fact",
      tags: ["search"],
      aliases: [],
      exposure: "self_improve_prompts",
      fidelity: "exact",
      status: "active",
      canonical: true,
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
  assert.ok(
    out.self_improve_prompt_context.includes("[agent_profile] Concise and natural"),
  );
  assert.ok(
    out.self_improve_prompt_context.includes(
      "[core_facts] Keep SearXNG design.",
    ),
  );
});
