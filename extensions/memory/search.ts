import type { MemoryDoc } from "./core/types.js";
import {
  searchIndexedMemoryDocs,
  searchMemoryDocsWithTempIndex,
  type MemoryDocIndexSearchOptions,
} from "./memory-doc-index.js";
import { safeString } from "./core/utils.js";

export function buildSearchQuery(value: string): string {
  return safeString(value).trim();
}

export function searchMemoryDocs(
  docs: MemoryDoc[],
  rawQuery: string,
  options: MemoryDocIndexSearchOptions = {},
) {
  const query = buildSearchQuery(rawQuery);
  if (!query) return [];
  return searchMemoryDocsWithTempIndex(docs, query, options);
}

export function searchIndexedMemoryDocsByRoot(
  rootDir: string,
  rawQuery: string,
  options: MemoryDocIndexSearchOptions = {},
) {
  const query = buildSearchQuery(rawQuery);
  if (!query) return [];
  return searchIndexedMemoryDocs(rootDir, query, options);
}
