import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

import { MemoryDoc, MEMORY_PROMPT_SLOTS } from "./core/types.js";
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
  assertMemoryPromptDoc,
  genericDocPath,
  loadMemoryDocs,
  loadMemoryDocsSync,
  memoryPromptPath,
  previewDocs,
  writeMemoryDoc,
} from "./docs.js";
import { activeDocsOnly } from "./relevance.js";
import { searchIndexedMemoryDocsByRoot } from "./search.js";
import { searchTranscriptArchive } from "./transcripts.js";
import { syncMemoryDocIndex } from "./memory-doc-index.js";
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
  await fs.mkdir(rootDir, { recursive: true });
  for (const rel of ["memory_prompts", "memory_docs", "transcripts", "state"]) {
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
  const exposureFilter = ensureExposure(
    safeString(params.exposure || "memory_docs"),
  );
  const scopeFilter = safeString(params.scope || "").trim();
  const kindFilter = safeString(params.kind || "").trim();
  const limit = Math.max(1, Number(params.limit || 200) || 200);
  const hasExposureFilter = safeString(params.exposure || "").trim().length > 0;
  const results = (await loadActiveMemoryDocs(rootOverride))
    .filter((doc) => !hasExposureFilter || doc.exposure === exposureFilter)
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
  const exposureRaw = safeString(params.exposure || "").trim();
  const exposureFilter = exposureRaw ? ensureExposure(exposureRaw) : "";
  const limit = Math.max(1, Number(params.limit || 8) || 8);
  const docResults = searchIndexedMemoryDocsByRoot(root, query, {
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

export async function saveMemoryPromptDoc(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  const content = safeString(params.content || "").trim();
  if (!content) throw new Error("memory_content_required");
  const memoryPromptSlot = safeString(
    params.memoryPromptSlot || params.residentSlot || "",
  ).trim();
  const doc: MemoryDoc = {
    id:
      safeString(params.id || "").trim() ||
      slugify(memoryPromptSlot, memoryPromptSlot),
    name:
      safeString(params.name || "").trim() ||
      memoryPromptSlot.replace(/_/g, " ") ||
      "memory prompt",
    exposure: "memory_prompts",
    fidelity: ensureFidelity(safeString(params.fidelity || "exact")),
    memory_prompt_slot: memoryPromptSlot,
    description: safeString(params.description || "").trim(),
    tags: normalizeList(params.tags || []),
    aliases: normalizeList(params.aliases || []),
    scope: ensureScope(safeString(params.scope || "global")),
    kind: ensureKind(
      safeString(
        params.kind ||
          (memoryPromptSlot === "core_facts" ? "fact" : "instruction"),
      ),
    ),
    sensitivity: safeString(params.sensitivity || "normal").trim() || "normal",
    source: safeString(params.source || "").trim(),
    updated_at: nowIso(),
    last_observed_at: nowIso(),
    observation_count: Math.max(1, Number(params.observationCount || 1) || 1),
    status: ensureStatus(safeString(params.status || "active")),
    supersedes: normalizeList(params.supersedes || []),
    canonical: true,
    path: memoryPromptPath(root, memoryPromptSlot),
    content,
  };
  assertMemoryPromptDoc(doc);
  await writeMemoryDoc(doc);
  return {
    status: "ok",
    action: "save_memory_prompt",
    doc: previewMemoryDoc(doc),
  };
}

export async function saveMemory(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  const content = safeString(params.content || "").trim();
  if (!content) throw new Error("memory_content_required");
  const exposure = ensureExposure(safeString(params.exposure || "memory_docs"));
  if (exposure === "memory_prompts") {
    throw new Error("memory_prompts_use_save_memory_prompt");
  }
  const name =
    safeString(params.name || "").trim() ||
    content.split(/\r?\n/)[0].trim().slice(0, 80) ||
    "memory";
  const id =
    safeString(params.id || "").trim() ||
    slugify(name, `memory-${sha(content).slice(0, 8)}`);
  const requestedPath = safeString(params.path || "").trim();
  const doc: MemoryDoc = {
    id,
    name,
    exposure: "memory_docs",
    fidelity: ensureFidelity(safeString(params.fidelity || "fuzzy")),
    memory_prompt_slot: "",
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
    path: requestedPath
      ? path.isAbsolute(requestedPath)
        ? requestedPath
        : path.join(root, requestedPath)
      : genericDocPath(root, "memory_docs", id),
    content,
  };
  await writeMemoryDoc(doc);
  syncMemoryDocIndex(root);
  return { status: "ok", action: "save", doc: previewMemoryDoc(doc) };
}

export async function removeMemoryPromptDoc(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  const slot = safeString(
    params.memoryPromptSlot || params.residentSlot || "",
  ).trim();
  if (!MEMORY_PROMPT_SLOTS.includes(slot as any)) {
    throw new Error(
      `memory_prompt_slot_required:${MEMORY_PROMPT_SLOTS.join(",")}`,
    );
  }
  const targetPath = memoryPromptPath(root, slot);
  await fs.rm(targetPath, { force: true });
  return {
    status: "ok",
    action: "remove_memory_prompt",
    memoryPromptSlot: slot,
    path: targetPath,
  };
}

export async function compileMemory(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveMemoryRoot(rootOverride);
  await ensureMemoryLayout(root);
  const docs = activeDocsOnly(await loadMemoryDocs(root));
  const limit = Math.max(
    0,
    Number(params.memoryDocLimit == null ? 6 : params.memoryDocLimit) || 6,
  );
  const queries = Array.from(
    new Set(
      [safeString(params.query || ""), safeString(params.domainQuery || "")]
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  const memoryDocs = !queries.length
    ? []
    : Array.from(
        new Map(
          queries.flatMap((needle) =>
            searchIndexedMemoryDocsByRoot(root, needle, {
              limit,
              exposure: "memory_docs",
            }).map((row) => [row.doc.id, row.doc] as const),
          ),
        ).values(),
      ).slice(0, limit);
  return compileFromDocsAndEvents(
    docs,
    [],
    { updated_at: "", edges: [] },
    { ...params, memoryDocs },
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
  const limit = Math.max(
    0,
    Number(params.memoryDocLimit == null ? 6 : params.memoryDocLimit) || 6,
  );
  const queries = Array.from(
    new Set(
      [safeString(params.query || ""), safeString(params.domainQuery || "")]
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  const memoryDocs = !queries.length
    ? []
    : Array.from(
        new Map(
          queries.flatMap((needle) =>
            searchIndexedMemoryDocsByRoot(root, needle, {
              limit,
              exposure: "memory_docs",
            }).map((row) => [row.doc.id, row.doc] as const),
          ),
        ).values(),
      ).slice(0, limit);
  return compileFromDocsAndEvents(
    docs,
    [],
    { updated_at: "", edges: [] },
    { ...params, memoryDocs },
    root,
  );
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
  if (action === "save_memory_prompt")
    return await saveMemoryPromptDoc(params, rootOverride);
  if (action === "remove_memory_prompt")
    return await removeMemoryPromptDoc(params, rootOverride);
  if (action === "compile") return await compileMemory(params, rootOverride);
  throw new Error(`unsupported_memory_action:${action}`);
}
