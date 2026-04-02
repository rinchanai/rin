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

function progressiveIndexLine(doc: MemoryDoc): string {
  const desc = trimText(
    doc.description ||
      excerptForRecall(doc, "", 160) ||
      "Read this when relevant.",
    180,
  );
  return `- ${doc.name}: ${desc}`;
}

function renderExpandedDoc(doc: MemoryDoc): string {
  return [`### ${doc.name}`, safeString(doc.content).trim()]
    .filter(Boolean)
    .join("\n\n");
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
  const progressiveDocs = docs
    .filter((doc) => doc.exposure === "progressive")
    .sort((a, b) =>
      safeString(b.updated_at).localeCompare(safeString(a.updated_at)),
    );
  const progressiveIndexLimit = Math.max(
    0,
    Number(params.progressiveLimit == null ? 12 : params.progressiveLimit) ||
      12,
  );
  const expandedProgressiveLimit = Math.max(
    0,
    Number(
      params.expandedProgressiveLimit == null
        ? 2
        : params.expandedProgressiveLimit,
    ) || 2,
  );
  const recallLimit = Math.max(
    0,
    Number(params.recallLimit == null ? 3 : params.recallLimit) || 3,
  );
  const expandedProgressives = !query
    ? []
    : searchMemoryDocs(progressiveDocs, query, {
        limit: expandedProgressiveLimit,
      }).map((row) => row.doc);

  const recallDocs = !query
    ? []
    : searchMemoryDocs(
        docs.filter((doc) => doc.exposure === "recall"),
        query,
        { limit: recallLimit },
      ).map((row) => row.doc);

  return {
    root,
    query,
    resident_slots: RESIDENT_SLOTS,
    resident: resident
      .map((doc) => residentPromptLine(doc.resident_slot, doc.content))
      .filter(Boolean)
      .join("\n"),
    progressive_index: progressiveDocs
      .slice(0, progressiveIndexLimit)
      .map(progressiveIndexLine)
      .join("\n"),
    progressive_expanded: expandedProgressives
      .map(renderExpandedDoc)
      .join("\n\n"),
    recall_context: recallDocs
      .map((doc) => renderRecallContext(doc, query))
      .join("\n\n"),
    resident_prompt_docs: resident.map((doc) => ({
      name: doc.name,
      resident_slot: doc.resident_slot,
      path: doc.path,
      content: safeString(doc.content).trim(),
    })),
    resident_docs: resident.map(previewMemoryDoc),
    progressive_docs: progressiveDocs
      .slice(0, progressiveIndexLimit)
      .map(previewMemoryDoc),
    expanded_progressives: expandedProgressives.map(previewMemoryDoc),
    episode_docs: [],
    recall_docs: recallDocs.map(previewMemoryDoc),
    related_docs: [],
    history_events: [],
  };
}
