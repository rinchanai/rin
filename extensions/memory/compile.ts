import {
  MemoryDoc,
  MemoryEvent,
  MEMORY_PROMPT_SLOTS,
  MemoryRelationGraph,
} from "./core/types.js";
import { previewMemoryDoc } from "./core/schema.js";
import { safeString } from "./core/utils.js";
import { excerptForRecall } from "./relevance.js";
import { searchMemoryDocs } from "./search.js";

function memoryPromptLine(slot: string, body: string): string {
  const text = safeString(body).trim();
  if (!text) return "";
  return `[${slot}] ${text}`;
}

function renderMemoryDocContext(doc: MemoryDoc, query: string): string {
  const excerpt = excerptForRecall(doc, query, 260);
  const meta = [doc.scope, doc.kind].filter(Boolean).join(" • ");
  return [`- ${doc.name}${meta ? ` — ${meta}` : ""}`, excerpt]
    .filter(Boolean)
    .join("\n  ");
}

export function compileFromDocsAndEvents(
  docs: MemoryDoc[],
  events: MemoryEvent[],
  graph: MemoryRelationGraph,
  params: Record<string, any> = {},
  root = "",
) {
  const query = safeString(params.query || "").trim();
  const domainQuery = safeString(params.domainQuery || "").trim();
  const memoryPrompts = docs
    .filter(
      (doc) =>
        doc.exposure === "memory_prompts" &&
        doc.canonical &&
        MEMORY_PROMPT_SLOTS.includes(doc.memory_prompt_slot as any),
    )
    .sort(
      (a, b) =>
        MEMORY_PROMPT_SLOTS.indexOf(a.memory_prompt_slot as any) -
        MEMORY_PROMPT_SLOTS.indexOf(b.memory_prompt_slot as any),
    );
  const memoryDocLimit = Math.max(
    0,
    Number(params.memoryDocLimit == null ? 6 : params.memoryDocLimit) || 6,
  );
  const memoryDocPool = docs.filter((doc) => doc.exposure === "memory_docs");
  const queries = Array.from(
    new Set(
      [query, domainQuery]
        .map((item) => safeString(item).trim())
        .filter(Boolean),
    ),
  );
  const memoryDocs = !queries.length
    ? []
    : Array.from(
        new Map(
          queries.flatMap((needle) =>
            searchMemoryDocs(memoryDocPool, needle, {
              limit: memoryDocLimit,
            }).map((row) => [row.doc.id, row.doc] as const),
          ),
        ).values(),
      ).slice(0, memoryDocLimit);

  return {
    root,
    query,
    domain_query: domainQuery,
    memory_prompt_slots: MEMORY_PROMPT_SLOTS,
    memory_prompt_context: memoryPrompts
      .map((doc) => memoryPromptLine(doc.memory_prompt_slot, doc.content))
      .filter(Boolean)
      .join("\n"),
    memory_doc_context: memoryDocs
      .map((doc) => renderMemoryDocContext(doc, query || domainQuery || ""))
      .join("\n\n"),
    memory_prompt_prompt_docs: memoryPrompts.map((doc) => ({
      name: doc.name,
      memory_prompt_slot: doc.memory_prompt_slot,
      path: doc.path,
      content: safeString(doc.content).trim(),
    })),
    memory_prompt_docs: memoryPrompts.map(previewMemoryDoc),
    memory_docs: memoryDocs.map(previewMemoryDoc),
    episode_docs: [],
    related_docs: [],
    history_events: [],
  };
}
