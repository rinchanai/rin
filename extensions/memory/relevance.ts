import { CHRONICLE_TAG, MemoryDoc, MemoryEvent } from "./core/types.js";
import {
  cjkBigrams,
  conceptTokens,
  normalizeNeedle,
  nowIso,
  safeString,
  trimText,
  uniqueStrings,
} from "./core/utils.js";

export function lexicalScore(query: string, doc: MemoryDoc): number {
  const q = normalizeNeedle(query);
  if (!q) return 0;
  const haystack = normalizeNeedle(
    [
      doc.name,
      doc.description,
      doc.content,
      doc.id,
      doc.resident_slot,
      doc.scope,
      doc.kind,
      ...doc.tags,
      ...doc.aliases,
    ].join(" \n "),
  );
  if (!haystack) return 0;
  let score = 0;
  if (haystack.includes(q)) score += 6;
  for (const token of q
    .split(/[^\p{Letter}\p{Number}_-]+/gu)
    .filter((item) => item.length >= 2)) {
    if (haystack.includes(token)) score += token.length >= 4 ? 1.2 : 0.6;
  }
  for (const token of cjkBigrams(q)) {
    if (haystack.includes(token)) score += 0.45;
  }
  if (doc.id === q) score += 6;
  if (doc.resident_slot === q) score += 6;
  if (doc.exposure === "progressive") score += 0.5;
  if (doc.exposure === "resident") score += 0.2;
  if (doc.status !== "active") score -= 8;
  if (
    doc.tags.includes(CHRONICLE_TAG) &&
    !/(history|timeline|recent|之前|最近|刚才|发生)/i.test(query)
  )
    score -= 1.4;
  return score;
}

export function eventScore(query: string, event: MemoryEvent): number {
  const q = normalizeNeedle(query);
  if (!q) return 0;
  const haystack = normalizeNeedle(
    [
      event.kind,
      event.summary,
      event.text,
      event.tool_name,
      event.cwd,
      ...event.tags,
    ].join(" \n "),
  );
  if (!haystack) return 0;
  let score = 0;
  if (haystack.includes(q)) score += 5;
  for (const token of q
    .split(/[^\p{Letter}\p{Number}_-]+/gu)
    .filter((item) => item.length >= 2)) {
    if (haystack.includes(token)) score += token.length >= 4 ? 1 : 0.5;
  }
  for (const token of cjkBigrams(q)) {
    if (haystack.includes(token)) score += 0.35;
  }
  const ageHours = Math.max(
    0,
    (Date.now() - Date.parse(event.created_at || nowIso())) / 3_600_000,
  );
  score += Math.max(0, 2 - ageHours / 24);
  return score;
}

export function excerptForRecall(
  doc: MemoryDoc,
  query: string,
  max = 240,
): string {
  const text = [doc.description, doc.content]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const q = safeString(query).trim().toLowerCase();
  if (!q || text.length <= max) return trimText(text, max);
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return trimText(text, max);
  const start = Math.max(0, idx - Math.floor(max / 3));
  const end = Math.min(text.length, start + max);
  const slice = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

function memoryRelationFeatures(doc: MemoryDoc): string[] {
  const contentSample = safeString(doc.content)
    .split(/\n+/)
    .slice(0, 12)
    .join("\n");
  return uniqueStrings(
    [
      ...conceptTokens(doc.name),
      ...conceptTokens(doc.description),
      ...conceptTokens(contentSample),
      ...doc.tags.map((item) => normalizeNeedle(item)),
      ...doc.aliases.map((item) => normalizeNeedle(item)),
      normalizeNeedle(doc.scope),
      normalizeNeedle(doc.kind),
    ].filter(Boolean),
  );
}

export function relationScore(
  a: MemoryDoc,
  b: MemoryDoc,
): { score: number; reason: string } {
  const aFeatures = new Set(memoryRelationFeatures(a));
  const bFeatures = new Set(memoryRelationFeatures(b));
  let overlap = 0;
  for (const feature of aFeatures) {
    if (bFeatures.has(feature)) overlap += 1;
  }
  const sharedTags = a.tags.filter((item) =>
    b.tags.some((other) => normalizeNeedle(other) === normalizeNeedle(item)),
  );
  const sharedTriggers: string[] = [];
  let score =
    Math.min(6, overlap) * 0.7 +
    sharedTags.length * 1.3 +
    sharedTriggers.length * 1.1;
  if (a.scope && a.scope === b.scope) score += 0.5;
  if (a.kind && a.kind === b.kind) score += 0.35;
  if (a.exposure !== b.exposure) score += 0.25;
  const reason = sharedTags.length
    ? "shared-tags"
    : sharedTriggers.length
      ? "shared-description"
      : overlap >= 3
        ? "shared-concepts"
        : a.scope === b.scope
          ? "shared-scope"
          : a.kind === b.kind
            ? "shared-kind"
            : "";
  return { score, reason };
}

export function shouldInjectRecentHistory(query: string): boolean {
  return /(history|timeline|recent|what happened|why did we|之前|最近|刚才|发生了什么|历史|时间线)/i.test(
    query,
  );
}

export function activeDocsOnly(docs: MemoryDoc[]): MemoryDoc[] {
  return docs.filter((doc) => doc.status === "active");
}
