import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import {
  CHRONICLE_TAG,
  EPISODE_TAG,
  MemoryDoc,
  MemoryEvent,
  MemoryExposure,
  MemoryFidelity,
  MemoryKind,
  MemoryRelationEdge,
  MemoryRelationGraph,
  MemoryScope,
  MemoryStatus,
  PROCESS_STATE_FILE,
  RELATIONS_STATE_FILE,
  RESIDENT_LIMITS,
  RESIDENT_SLOTS,
} from './core/types.js'
import {
  ensureExposure,
  ensureFidelity,
  ensureKind,
  ensureScope,
  ensureStatus,
  previewMemoryDoc,
} from './core/schema.js'
import { compileFromDocsAndEvents } from './compile.js'
import {
  appendChronicleEntry,
  assertResidentDoc,
  genericDocPath,
  loadMemoryDocs,
  loadMemoryDocsSync,
  previewDocs,
  residentPath,
  resolveMemoryDoc,
  walkMarkdownFiles,
  writeMemoryDoc,
} from './docs.js'
import {
  eventSummary,
  eventLogPath,
  loadEvents,
  logMemoryEventRecord,
  parseEventLine,
} from './events.js'
import {
  activeDocsOnly,
  eventScore,
  lexicalScore,
  relationScore,
} from './relevance.js'
import {
  latinTokens,
  normalizeList,
  nowIso,
  resolveAgentDir,
  safeString,
  sha,
  slugify,
  trimText,
} from './core/utils.js'

export function resolveMemoryRoot(rootOverride = ''): string {
  if (safeString(rootOverride).trim()) return path.join(path.resolve(rootOverride), 'memory')
  return path.join(resolveAgentDir(), 'memory')
}


export async function ensureMemoryLayout(rootDir: string): Promise<void> {
  for (const rel of ['resident', 'progressive', 'recall', 'events', 'state']) {
    await fs.mkdir(path.join(rootDir, rel), { recursive: true })
  }
}

function statePath(rootDir: string): string {
  return path.join(rootDir, 'state', PROCESS_STATE_FILE)
}

function relationsPath(rootDir: string): string {
  return path.join(rootDir, 'state', RELATIONS_STATE_FILE)
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}

async function rebuildRelationGraph(rootDir: string, docs?: MemoryDoc[]) {
  const allDocs = activeDocsOnly(docs || await loadMemoryDocs(rootDir))
  const edges: MemoryRelationEdge[] = []
  for (let index = 0; index < allDocs.length; index += 1) {
    for (let inner = index + 1; inner < allDocs.length; inner += 1) {
      const left = allDocs[index]
      const right = allDocs[inner]
      const relation = relationScore(left, right)
      if (relation.score < 1.5) continue
      edges.push({ from: left.id, to: right.id, score: relation.score, reason: relation.reason || 'related' })
      edges.push({ from: right.id, to: left.id, score: relation.score, reason: relation.reason || 'related' })
    }
  }
  const graph: MemoryRelationGraph = { updated_at: nowIso(), edges: edges.sort((a, b) => b.score - a.score || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)) }
  await writeJson(relationsPath(rootDir), graph)
  return graph
}

async function loadRelationGraph(rootDir: string): Promise<MemoryRelationGraph> {
  return await readJson<MemoryRelationGraph>(relationsPath(rootDir), { updated_at: '', edges: [] })
}


export async function logMemoryEvent(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  return { status: 'ok', event: await logMemoryEventRecord(root, params) }
}

async function listEvents(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const limit = Math.max(1, Number(params.limit || 50) || 50)
  const results = await loadEvents(root, { since: safeString(params.since || ''), limit })
  return { root, count: results.length, results }
}

async function searchEvents(query: string, params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const limit = Math.max(1, Number(params.limit || 10) || 10)
  const rows = (await loadEvents(root, { limit: 2_000 }))
    .map((event) => ({ event, score: eventScore(query, event) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || safeString(b.event.created_at).localeCompare(safeString(a.event.created_at)))
    .slice(0, limit)
  return {
    query,
    count: rows.length,
    results: rows.map((row) => ({ score: row.score, ...row.event })),
  }
}

async function reconcileMemoryLifecycle(rootDir: string) {
  const docs = await loadMemoryDocs(rootDir)
  await rebuildRelationGraph(rootDir, docs)
  return [] as Array<Record<string, any>>
}

export async function processPendingEvents(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const state = await readJson<{ lastProcessedAt: string }> (statePath(root), { lastProcessedAt: '' })
  const pending = await loadEvents(root, { since: safeString(params.since || state.lastProcessedAt || '') })
  let chroniclesUpdated = 0
  for (const event of pending) {
    if (await appendChronicleEntry(root, event)) chroniclesUpdated += 1
  }
  const episodeDocsUpdated = 0
  const lifecycle_changes = await reconcileMemoryLifecycle(root)
  const docs = await loadMemoryDocs(root)
  const graph = await rebuildRelationGraph(root, docs)
  const lastProcessedAt = pending.length ? pending[pending.length - 1].created_at : state.lastProcessedAt
  await writeJson(statePath(root), { lastProcessedAt })
  return {
    status: 'ok',
    pending_count: pending.length,
    chronicles_updated: chroniclesUpdated,
    episode_docs_updated: episodeDocsUpdated,
    applied_count: 0,
    applied: [],
    lifecycle_change_count: lifecycle_changes.length,
    lifecycle_changes,
    relation_edges: graph.edges.length,
    last_processed_at: lastProcessedAt,
  }
}

export async function listMemories(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const exposureFilter = safeString(params.exposure || '').trim()
  const scopeFilter = safeString(params.scope || '').trim()
  const kindFilter = safeString(params.kind || '').trim()
  const limit = Math.max(1, Number(params.limit || 200) || 200)
  const results = activeDocsOnly(await loadMemoryDocs(root))
    .filter((doc) => !exposureFilter || doc.exposure === exposureFilter)
    .filter((doc) => !scopeFilter || doc.scope === scopeFilter)
    .filter((doc) => !kindFilter || doc.kind === kindFilter)
    .sort((a, b) => safeString(b.updated_at).localeCompare(safeString(a.updated_at)))
    .slice(0, limit)
  return { root, count: results.length, results: previewDocs(results) }
}

export async function searchMemories(query: string, params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const exposureFilter = safeString(params.exposure || '').trim()
  const limit = Math.max(1, Number(params.limit || 20) || 20)
  const docs = activeDocsOnly(await loadMemoryDocs(root)).filter((doc) => !exposureFilter || doc.exposure === exposureFilter)
  const results = docs
    .map((doc) => ({ doc, score: lexicalScore(query, doc) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || safeString(b.doc.updated_at).localeCompare(safeString(a.doc.updated_at)))
    .slice(0, limit)
  const graph = await loadRelationGraph(root)
  const topIds = new Set(results.slice(0, Math.min(3, results.length)).map((row) => row.doc.id))
  const related = (() => {
    const seen = new Set<string>()
    const out: Array<Record<string, any>> = []
    for (const edge of graph.edges.sort((a, b) => b.score - a.score)) {
      if (!topIds.has(edge.from)) continue
      const doc = docs.find((item) => item.id === edge.to)
      if (!doc || seen.has(doc.id) || topIds.has(doc.id)) continue
      if (docs.some((item) => item.tags.includes(EPISODE_TAG)) && doc.tags.includes(CHRONICLE_TAG)) continue
      seen.add(doc.id)
      out.push({ score: edge.score, reason: edge.reason, ...previewMemoryDoc(doc) })
      if (out.length >= 6) break
    }
    return out
  })()
  const events = (await searchEvents(query, { limit: Math.min(limit, 8) }, rootOverride)).results || []
  return {
    query,
    count: results.length,
    results: results.map((row) => ({ score: row.score, ...previewMemoryDoc(row.doc) })),
    related_matches: related,
    event_matches: events,
  }
}

export async function getMemory(target: string, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const doc = await resolveMemoryDoc(root, target)
  if (!doc) throw new Error(`memory_not_found:${target}`)
  return { ...previewMemoryDoc(doc), content: doc.content }
}

export async function saveMemory(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const content = safeString(params.content || '').trim()
  if (!content) throw new Error('memory_content_required')
  const exposure = ensureExposure(safeString(params.exposure || 'recall'))
  const title = safeString(params.title || '').trim() || content.split(/\r?\n/)[0].trim().slice(0, 80) || 'memory'
  const id = safeString(params.id || '').trim() || slugify(title, `memory-${sha(content).slice(0, 8)}`)
  const doc: MemoryDoc = {
    id,
    title,
    exposure,
    fidelity: ensureFidelity(safeString(params.fidelity || (exposure === 'resident' ? 'exact' : 'fuzzy'))),
    resident_slot: safeString(params.residentSlot || '').trim(),
    summary: safeString(params.summary || '').trim(),
    tags: normalizeList(params.tags || []),
    aliases: normalizeList(params.aliases || []),
    triggers: normalizeList(params.triggers || []),
    scope: ensureScope(safeString(params.scope || (exposure === 'resident' ? 'global' : 'project'))),
    kind: ensureKind(safeString(params.kind || (exposure === 'resident' ? 'preference' : 'knowledge'))),
    sensitivity: safeString(params.sensitivity || 'normal').trim() || 'normal',
    source: safeString(params.source || '').trim(),
    updated_at: nowIso(),
    last_observed_at: nowIso(),
    observation_count: Math.max(1, Number(params.observationCount || 1) || 1),
    status: ensureStatus(safeString(params.status || 'active')),
    supersedes: normalizeList(params.supersedes || []),
    canonical: exposure === 'resident',
    path: '',
    content,
  }
  if (exposure === 'resident') {
    assertResidentDoc({ ...doc, path: residentPath(root, doc.resident_slot) })
    doc.path = residentPath(root, doc.resident_slot)
  } else {
    doc.path = genericDocPath(root, exposure, id)
  }
  await writeMemoryDoc(doc)
  await rebuildRelationGraph(root)
  return { status: 'ok', action: 'save', doc: previewMemoryDoc(doc) }
}

export async function deleteMemory(target: string, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const doc = await resolveMemoryDoc(root, target)
  if (!doc) throw new Error(`memory_not_found:${target}`)
  await fs.rm(doc.path, { force: true })
  await rebuildRelationGraph(root)
  return { status: 'ok', action: 'delete', id: doc.id, path: doc.path }
}

export async function moveMemory(target: string, params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const doc = await resolveMemoryDoc(root, target)
  if (!doc) throw new Error(`memory_not_found:${target}`)
  const nextExposure = ensureExposure(safeString(params.exposure || doc.exposure), doc.exposure)
  const moved: MemoryDoc = {
    ...doc,
    exposure: nextExposure,
    resident_slot: nextExposure === 'resident' ? safeString(params.residentSlot || doc.resident_slot).trim() : '',
    scope: ensureScope(safeString(params.scope || doc.scope), doc.scope),
    kind: ensureKind(safeString(params.kind || doc.kind), doc.kind),
    updated_at: nowIso(),
    canonical: nextExposure === 'resident',
    path: nextExposure === 'resident'
      ? residentPath(root, safeString(params.residentSlot || doc.resident_slot).trim())
      : genericDocPath(root, nextExposure, doc.id),
  }
  if (nextExposure === 'resident') assertResidentDoc(moved)
  await fs.rm(doc.path, { force: true })
  await writeMemoryDoc(moved)
  await rebuildRelationGraph(root)
  return { status: 'ok', action: 'move', doc: previewMemoryDoc(moved) }
}


export async function compileMemory(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const docs = activeDocsOnly(await loadMemoryDocs(root))
  const events = await loadEvents(root, { limit: 500 })
  const graph = await loadRelationGraph(root)
  return compileFromDocsAndEvents(docs, events, graph, params, root)
}

export function compileMemorySync(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  if (!fssync.existsSync(root)) return compileFromDocsAndEvents([], [], { updated_at: '', edges: [] }, params, root)
  const docs = activeDocsOnly(loadMemoryDocsSync(root))
  const eventsDir = path.join(root, 'events')
  const events: MemoryEvent[] = []
  if (fssync.existsSync(eventsDir)) {
    const files = fssync.readdirSync(eventsDir).filter((name) => name.endsWith('.jsonl')).sort()
    for (const name of files.slice(-7)) {
      try {
        const text = fssync.readFileSync(path.join(eventsDir, name), 'utf8')
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue
          const event = parseEventLine(line)
          if (event) events.push(event)
        }
      } catch {}
    }
  }
  let graph: MemoryRelationGraph = { updated_at: '', edges: [] }
  try {
    graph = JSON.parse(fssync.readFileSync(relationsPath(root), 'utf8')) as MemoryRelationGraph
  } catch {}
  return compileFromDocsAndEvents(docs, events, graph, params, root)
}

export async function doctorMemory(rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const docs = await loadMemoryDocs(root)
  const activeDocs = activeDocsOnly(docs)
  const counts = { resident: 0, progressive: 0, recall: 0 }
  for (const doc of activeDocs) counts[doc.exposure] += 1
  const events = await loadEvents(root, { limit: 10_000 })
  const state = await readJson<{ lastProcessedAt: string }>(statePath(root), { lastProcessedAt: '' })
  const graph = await loadRelationGraph(root)
  return {
    root,
    resident_slots: RESIDENT_SLOTS,
    counts,
    total: docs.length,
    active_total: activeDocs.length,
    inactive_total: docs.length - activeDocs.length,
    event_count: events.length,
    last_processed_at: state.lastProcessedAt,
    resident_missing_slots: RESIDENT_SLOTS.filter((slot) => !docs.some((doc) => doc.exposure === 'resident' && doc.resident_slot === slot)),
    chronicle_docs: docs.filter((doc) => doc.tags.includes(CHRONICLE_TAG)).length,
    episode_docs: docs.filter((doc) => doc.tags.includes(EPISODE_TAG)).length,
    relation_edges: graph.edges.length,
    relation_updated_at: graph.updated_at,
  }
}

export async function executeMemoryAction(params: Record<string, any> = {}, rootOverride = '') {
  const action = safeString(params.action || '').trim()
  if (action === 'list') return await listMemories(params, rootOverride)
  if (action === 'search') return await searchMemories(safeString(params.query || ''), params, rootOverride)
  if (action === 'get') return await getMemory(safeString(params.path || params.id || params.query || ''), rootOverride)
  if (action === 'save') return await saveMemory(params, rootOverride)
  if (action === 'delete') return await deleteMemory(safeString(params.path || params.id || params.query || ''), rootOverride)
  if (action === 'move') return await moveMemory(safeString(params.path || params.id || params.query || ''), params, rootOverride)
  if (action === 'compile') return await compileMemory(params, rootOverride)
  if (action === 'doctor') return await doctorMemory(rootOverride)
  if (action === 'log_event') return await logMemoryEvent(params, rootOverride)
  if (action === 'events') return await listEvents(params, rootOverride)
  if (action === 'event_search') return await searchEvents(safeString(params.query || ''), params, rootOverride)
  if (action === 'process') return await processPendingEvents(params, rootOverride)
  throw new Error(`unsupported_memory_action:${action}`)
}
