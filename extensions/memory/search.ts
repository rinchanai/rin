import MiniSearch from "minisearch";

import type { MemoryDoc } from "./core/types.js";
import { safeString } from "./core/utils.js";

type IndexedMemoryDoc = MemoryDoc & { _search_id: string };

export function buildSearchQuery(value: string): string {
  return safeString(value).trim();
}

function createMemoryMiniSearch(
  docs: IndexedMemoryDoc[],
): MiniSearch<IndexedMemoryDoc> {
  const miniSearch = new MiniSearch<IndexedMemoryDoc>({
    idField: "_search_id",
    fields: [
      "name",
      "description",
      "content",
      "id",
      "resident_slot",
      "scope",
      "kind",
      "tags",
      "aliases",
    ],
    storeFields: [
      "path",
      "name",
      "description",
      "exposure",
      "scope",
      "kind",
      "resident_slot",
      "updated_at",
    ],
    searchOptions: {
      boost: {
        name: 6,
        id: 5,
        resident_slot: 5,
        tags: 4,
        aliases: 4,
        description: 3,
        kind: 2,
        scope: 1.5,
        content: 1,
      },
      prefix: true,
      combineWith: "AND",
    },
  });
  miniSearch.addAll(docs);
  return miniSearch;
}

export function searchMemoryDocs(
  docs: MemoryDoc[],
  rawQuery: string,
  options: { limit?: number; exposure?: string } = {},
): Array<{ doc: MemoryDoc; score: number; query: string }> {
  const limit = Math.max(1, Number(options.limit || 8) || 8);
  const exposure = safeString(options.exposure || "").trim();
  const query = buildSearchQuery(rawQuery);
  if (!query) return [];
  const indexedDocs = docs
    .filter(
      (doc) =>
        doc.status === "active" && (!exposure || doc.exposure === exposure),
    )
    .map((doc, index) => ({
      ...doc,
      _search_id: doc.path || doc.id || `memory-doc-${index + 1}`,
    }));
  if (!indexedDocs.length) return [];
  const miniSearch = createMemoryMiniSearch(indexedDocs);
  const rows = miniSearch.search(query).slice(0, limit);
  if (!rows.length) return [];
  const docsBySearchId = new Map(
    indexedDocs.map((doc) => [doc._search_id, doc]),
  );
  return rows
    .map((row) => ({
      doc: docsBySearchId.get(String(row.id || ""))!,
      score: Number(row?.score || 0),
      query,
    }))
    .filter((row) => row.doc);
}
