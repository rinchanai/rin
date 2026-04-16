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

test("memory relevance scores docs and relations", () => {
  const docA = {
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
  assert.equal(relevance.shouldInjectRecentHistory("what happened recently"), true);
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
