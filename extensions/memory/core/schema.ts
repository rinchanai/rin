import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type {
  MemoryDoc,
  MemoryExposure,
  MemoryFidelity,
  MemoryKind,
  MemoryScope,
  MemoryStatus,
} from "./types.js";
import { nowIso, normalizeList, safeString, slugify } from "./utils.js";

export function ensureExposure(
  value: string,
  fallback: MemoryExposure = "recall",
): MemoryExposure {
  const normalized = safeString(value).trim();
  if (
    normalized === "resident" ||
    normalized === "progressive" ||
    normalized === "recall"
  )
    return normalized;
  return fallback;
}

export function ensureFidelity(
  value: string,
  fallback: MemoryFidelity = "fuzzy",
): MemoryFidelity {
  const normalized = safeString(value).trim();
  if (normalized === "exact" || normalized === "fuzzy") return normalized;
  return fallback;
}

export function ensureScope(
  value: string,
  fallback: MemoryScope = "project",
): MemoryScope {
  const normalized = safeString(value).trim();
  if (
    normalized === "global" ||
    normalized === "domain" ||
    normalized === "project" ||
    normalized === "session"
  )
    return normalized;
  return fallback;
}

export function ensureKind(
  value: string,
  fallback: MemoryKind = "knowledge",
): MemoryKind {
  const normalized = safeString(value).trim();
  if (
    normalized === "identity" ||
    normalized === "style" ||
    normalized === "method" ||
    normalized === "value" ||
    normalized === "preference" ||
    normalized === "rule" ||
    normalized === "knowledge" ||
    normalized === "history"
  )
    return normalized;
  return fallback;
}

export function ensureStatus(
  value: string,
  fallback: MemoryStatus = "active",
): MemoryStatus {
  const normalized = safeString(value).trim();
  if (
    normalized === "active" ||
    normalized === "superseded" ||
    normalized === "invalidated"
  )
    return normalized;
  return fallback;
}

export function normalizeFrontmatter(
  raw: Record<string, any>,
  filePath: string,
  content: string,
): MemoryDoc {
  const exposure = ensureExposure(safeString(raw.exposure || "recall"));
  const residentSlot = safeString(raw.resident_slot || "").trim();
  const title =
    safeString(raw.title || "").trim() ||
    (residentSlot
      ? residentSlot.replace(/_/g, " ")
      : path.basename(filePath, ".md"));
  const id =
    safeString(raw.id || "").trim() ||
    slugify(title, path.basename(filePath, ".md"));
  return {
    id,
    title,
    exposure,
    fidelity: ensureFidelity(safeString(raw.fidelity || "fuzzy")),
    resident_slot: residentSlot,
    summary: safeString(raw.summary || "").trim(),
    tags: normalizeList(raw.tags || ""),
    aliases: normalizeList(raw.aliases || ""),
    triggers: normalizeList(raw.triggers || ""),
    scope: ensureScope(
      safeString(raw.scope || (exposure === "resident" ? "global" : "project")),
    ),
    kind: ensureKind(
      safeString(
        raw.kind || (exposure === "resident" ? "preference" : "knowledge"),
      ),
    ),
    sensitivity: safeString(raw.sensitivity || "normal").trim() || "normal",
    source: safeString(raw.source || "").trim(),
    updated_at: safeString(raw.updated_at || "").trim() || nowIso(),
    last_observed_at:
      safeString(raw.last_observed_at || raw.updated_at || "").trim() ||
      nowIso(),
    observation_count: Math.max(1, Number(raw.observation_count || 1) || 1),
    status: ensureStatus(safeString(raw.status || "active")),
    supersedes: normalizeList(raw.supersedes || ""),
    canonical:
      raw.canonical == null ? exposure === "resident" : Boolean(raw.canonical),
    path: filePath,
    content,
  };
}

export function parseMarkdownDoc(filePath: string, text: string): MemoryDoc {
  const raw = safeString(text);
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return normalizeFrontmatter({}, filePath, raw.trim());
  let frontmatter: Record<string, any> = {};
  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === "object")
      frontmatter = parsed as Record<string, any>;
  } catch {}
  return normalizeFrontmatter(
    frontmatter,
    filePath,
    safeString(match[2]).trim(),
  );
}

export function renderMarkdownDoc(doc: MemoryDoc): string {
  const fm = {
    id: doc.id,
    title: doc.title,
    exposure: doc.exposure,
    fidelity: doc.fidelity,
    ...(doc.resident_slot ? { resident_slot: doc.resident_slot } : {}),
    ...(doc.summary ? { summary: doc.summary } : {}),
    ...(doc.tags.length ? { tags: doc.tags } : {}),
    ...(doc.aliases.length ? { aliases: doc.aliases } : {}),
    ...(doc.triggers.length ? { triggers: doc.triggers } : {}),
    ...(doc.scope ? { scope: doc.scope } : {}),
    ...(doc.kind ? { kind: doc.kind } : {}),
    ...(doc.sensitivity ? { sensitivity: doc.sensitivity } : {}),
    ...(doc.source ? { source: doc.source } : {}),
    updated_at: doc.updated_at || nowIso(),
    last_observed_at: doc.last_observed_at || doc.updated_at || nowIso(),
    observation_count: Math.max(1, Number(doc.observation_count || 1) || 1),
    status: doc.status || "active",
    ...(doc.supersedes.length ? { supersedes: doc.supersedes } : {}),
    canonical: Boolean(doc.canonical),
  };
  const yaml = stringifyYaml(fm).trim();
  return `---\n${yaml}\n---\n${safeString(doc.content).trim()}\n`;
}

export function previewMemoryDoc(doc: MemoryDoc): Record<string, any> {
  return {
    id: doc.id,
    title: doc.title,
    exposure: doc.exposure,
    fidelity: doc.fidelity,
    resident_slot: doc.resident_slot || undefined,
    summary: doc.summary || undefined,
    tags: doc.tags,
    aliases: doc.aliases,
    triggers: doc.triggers,
    scope: doc.scope,
    kind: doc.kind,
    sensitivity: doc.sensitivity,
    source: doc.source || undefined,
    updated_at: doc.updated_at,
    last_observed_at: doc.last_observed_at,
    observation_count: doc.observation_count,
    status: doc.status,
    supersedes: doc.supersedes,
    canonical: doc.canonical,
    path: doc.path,
    preview: safeString(doc.content).trim().slice(0, 240),
  };
}
