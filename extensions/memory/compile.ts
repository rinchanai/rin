import {
  MemoryDoc,
  MemoryEvent,
  MemoryRelationGraph,
  RESIDENT_SLOTS,
} from "./core/types.js";
import { previewMemoryDoc } from "./core/schema.js";
import { safeString, trimText } from "./core/utils.js";
import { excerptForRecall } from "./relevance.js";
import { searchMemoryDocs } from "./search.js";

function residentPromptLine(slot: string, body: string): string {
  const text = safeString(body).trim();
  if (!text) return "";
  return `[${slot}] ${text}`;
}

function renderRecallContext(doc: MemoryDoc, query: string): string {
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
  const resident = docs
    .filter(
      (doc) =>
        doc.exposure === "resident" &&
        doc.canonical &&
        RESIDENT_SLOTS.includes(doc.resident_slot as any),
    )
    .sort(
      (a, b) =>
        RESIDENT_SLOTS.indexOf(a.resident_slot as any) -
        RESIDENT_SLOTS.indexOf(b.resident_slot as any),
    );
  const recallLimit = Math.max(
    0,
    Number(params.recallLimit == null ? 6 : params.recallLimit) || 6,
  );

  const recallPool = docs.filter((doc) => doc.exposure === "recall");
  const recallQueries = Array.from(
    new Set(
      [query, safeString(params.domainQuery || "").trim()]
        .map((value) => safeString(value).trim())
        .filter(Boolean),
    ),
  );
  const recallDocs = !recallQueries.length
    ? []
    : Array.from(
        new Map(
          recallQueries
            .flatMap((needle) =>
              searchMemoryDocs(recallPool, needle, {
                limit: recallLimit,
              }).map((row) => [row.doc.id, row.doc] as const),
            )
            .slice(0, recallLimit),
        ).values(),
      ).slice(0, recallLimit);

  return {
    root,
    query,
    resident_slots: RESIDENT_SLOTS,
    resident: resident
      .map((doc) => residentPromptLine(doc.resident_slot, doc.content))
      .filter(Boolean)
      .join("\n"),
    recall_context: recallDocs
      .map((doc) => renderRecallContext(doc, query || recallQueries[0] || ""))
      .join("\n\n"),
    resident_prompt_docs: resident.map((doc) => ({
      name: doc.name,
      resident_slot: doc.resident_slot,
      path: doc.path,
      content: safeString(doc.content).trim(),
    })),
    resident_docs: resident.map(previewMemoryDoc),
    episode_docs: [],
    recall_docs: recallDocs.map(previewMemoryDoc),
    related_docs: [],
    history_events: [],
  };
}
