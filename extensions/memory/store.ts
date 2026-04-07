import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

import { MemoryDoc, RESIDENT_SLOTS } from "./core/types.js";
import {
  ensureExposure,
  ensureFidelity,
  ensureKind,
  ensureScope,
  ensureStatus,
  previewMemoryDoc,
} from "./core/schema.js";
import { compileFromDocsAndEvents } from "./compile.js";
import {
  assertResidentDoc,
  genericDocPath,
  loadMemoryDocs,
  loadMemoryDocsSync,
  previewDocs,
  residentPath,
  writeMemoryDoc,
} from "./docs.js";
import { activeDocsOnly } from "./relevance.js";
import { searchMemoryDocs } from "./search.js";
import { searchTranscriptArchive } from "./transcripts.js";
import {
  normalizeList,
  nowIso,
  resolveAgentDir,
  safeString,
  sha,
  slugify,
} from "./core/utils.js";

export function resolveMemoryRoot(rootOverride = ""): string {
  if (safeString(rootOverride).trim())
    return path.join(path.resolve(rootOverride), "memory");
  return path.join(resolveAgentDir(), "memory");
}

export async function ensureMemoryLayout(rootDir: string): Promise<void> {
  for (const rel of ["resident", "progressive", "recall", "transcripts"]) {
    await fs.mkdir(path.join(rootDir, rel), { recursive: true });
  }
}

export async function loadActiveMemoryDocs(rootOverride = "") {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  return activeDocsOnly(await loadMemoryDocs(root));
}

export async function listMemories(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  const exposureFilter = safeString(params.exposure || "").trim();
  const scopeFilter = safeString(params.scope || "").trim();
  const kindFilter = safeString(params.kind || "").trim();
  const limit = Math.max(1, Number(params.limit || 200) || 200);
  const results = (await loadActiveMemoryDocs(rootOverride))
    .filter((doc) => !exposureFilter || doc.exposure === exposureFilter)
    .filter((doc) => !scopeFilter || doc.scope === scopeFilter)
    .filter((doc) => !kindFilter || doc.kind === kindFilter)
    .sort((a, b) =>
      safeString(b.updated_at).localeCompare(safeString(a.updated_at)),
    )
    .slice(0, limit);
  return { root, count: results.length, results: previewDocs(results) };
}

export async function searchMemories(
  query: string,
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  const exposureFilter = safeString(params.exposure || "").trim();
  const limit = Math.max(1, Number(params.limit || 8) || 8);
  const docs = activeDocsOnly(await loadMemoryDocs(root));
  const docResults = searchMemoryDocs(docs, query, {
    limit,
    exposure: exposureFilter,
  }).map((row) => ({
    sourceType: "memory",
    score: row.score,
    ...previewMemoryDoc(row.doc),
  }));
  const transcriptResults = await searchTranscriptArchive(
    query,
    params,
    rootOverride,
  );
  const results = [...docResults, ...transcriptResults]
    .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
    .slice(0, limit);
  return {
    query,
    count: results.length,
    results,
  };
}

export async function saveResidentMemoryDoc(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  const content = safeString(params.content || "").trim();
  if (!content) throw new Error("memory_content_required");
  const residentSlot = safeString(params.residentSlot || "").trim();
  const doc: MemoryDoc = {
    id:
      safeString(params.id || "").trim() || slugify(residentSlot, residentSlot),
    name:
      safeString(params.name || "").trim() ||
      residentSlot.replace(/_/g, " ") ||
      "resident memory",
    exposure: "resident",
    fidelity: ensureFidelity(safeString(params.fidelity || "exact")),
    resident_slot: residentSlot,
    description: safeString(params.description || "").trim(),
    tags: normalizeList(params.tags || []),
    aliases: normalizeList(params.aliases || []),
    scope: ensureScope(safeString(params.scope || "global")),
    kind: ensureKind(safeString(params.kind || "instruction")),
    sensitivity: safeString(params.sensitivity || "normal").trim() || "normal",
    source: safeString(params.source || "").trim(),
    updated_at: nowIso(),
    last_observed_at: nowIso(),
    observation_count: Math.max(1, Number(params.observationCount || 1) || 1),
    status: ensureStatus(safeString(params.status || "active")),
    supersedes: normalizeList(params.supersedes || []),
    canonical: true,
    path: residentPath(root, residentSlot),
    content,
  };
  assertResidentDoc(doc);
  await writeMemoryDoc(doc);
  return { status: "ok", action: "save_resident", doc: previewMemoryDoc(doc) };
}

export async function saveMemory(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  const content = safeString(params.content || "").trim();
  if (!content) throw new Error("memory_content_required");
  const exposure = ensureExposure(safeString(params.exposure || "recall"));
  if (exposure === "resident") {
    throw new Error("resident_memory_uses_save_resident_memory");
  }
  const name =
    safeString(params.name || "").trim() ||
    content.split(/\r?\n/)[0].trim().slice(0, 80) ||
    "memory";
  const id =
    safeString(params.id || "").trim() ||
    slugify(name, `memory-${sha(content).slice(0, 8)}`);
  const doc: MemoryDoc = {
    id,
    name,
    exposure,
    fidelity: ensureFidelity(safeString(params.fidelity || "fuzzy")),
    resident_slot: "",
    description: safeString(params.description || "").trim(),
    tags: normalizeList(params.tags || []),
    aliases: normalizeList(params.aliases || []),
    scope: ensureScope(safeString(params.scope || "project")),
    kind: ensureKind(safeString(params.kind || "fact")),
    sensitivity: safeString(params.sensitivity || "normal").trim() || "normal",
    source: safeString(params.source || "").trim(),
    updated_at: nowIso(),
    last_observed_at: nowIso(),
    observation_count: Math.max(1, Number(params.observationCount || 1) || 1),
    status: ensureStatus(safeString(params.status || "active")),
    supersedes: normalizeList(params.supersedes || []),
    canonical: false,
    path: genericDocPath(root, exposure, id),
    content,
  };
  await writeMemoryDoc(doc);
  return { status: "ok", action: "save", doc: previewMemoryDoc(doc) };
}

export async function compileMemory(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  const docs = activeDocsOnly(await loadMemoryDocs(root));
  return compileFromDocsAndEvents(
    docs,
    [],
    { updated_at: "", edges: [] },
    params,
    root,
  );
}

export function compileMemorySync(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveMemoryRoot(rootOverride);
  if (!fssync.existsSync(root))
    return compileFromDocsAndEvents(
      [],
      [],
      { updated_at: "", edges: [] },
      params,
      root,
    );
  const docs = activeDocsOnly(loadMemoryDocsSync(root));
  return compileFromDocsAndEvents(
    docs,
    [],
    { updated_at: "", edges: [] },
    params,
    root,
  );
}

export async function doctorMemory(rootOverride = "") {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  const docs = await loadMemoryDocs(root);
  const activeDocs = activeDocsOnly(docs);
  const counts = { resident: 0, recall: 0 };
  for (const doc of activeDocs) counts[doc.exposure] += 1;
  return {
    root,
    resident_slots: RESIDENT_SLOTS,
    counts,
    total: docs.length,
    active_total: activeDocs.length,
    inactive_total: docs.length - activeDocs.length,
    resident_missing_slots: RESIDENT_SLOTS.filter(
      (slot) =>
        !docs.some(
          (doc) => doc.exposure === "resident" && doc.resident_slot === slot,
        ),
    ),
  };
}

export async function executeMemoryAction(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const action = safeString(params.action || "").trim();
  if (action === "list") return await listMemories(params, rootOverride);
  if (action === "search")
    return await searchMemories(
      safeString(params.query || ""),
      params,
      rootOverride,
    );
  if (action === "save") return await saveMemory(params, rootOverride);
  if (action === "save_resident")
    return await saveResidentMemoryDoc(params, rootOverride);
  if (action === "compile") return await compileMemory(params, rootOverride);
  if (action === "doctor") return await doctorMemory(rootOverride);
  throw new Error(`unsupported_memory_action:${action}`);
}
