import fs from 'node:fs/promises'
import fssync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export type MemoryExposure = 'resident' | 'progressive' | 'recall'
export type MemoryFidelity = 'exact' | 'fuzzy'
export type MemoryScope = 'global' | 'domain' | 'project' | 'session'
export type MemoryKind = 'identity' | 'style' | 'method' | 'value' | 'preference' | 'rule' | 'knowledge' | 'history'

export type MemoryStatus = 'active' | 'superseded' | 'invalidated'

export type MemoryDoc = {
  id: string
  title: string
  exposure: MemoryExposure
  fidelity: MemoryFidelity
  resident_slot: string
  summary: string
  tags: string[]
  aliases: string[]
  triggers: string[]
  scope: MemoryScope
  kind: MemoryKind
  sensitivity: string
  source: string
  updated_at: string
  last_observed_at: string
  observation_count: number
  status: MemoryStatus
  supersedes: string[]
  canonical: boolean
  path: string
  content: string
}

export type MemoryEvent = {
  id: string
  created_at: string
  kind: 'user_input' | 'assistant_message' | 'tool_result' | 'system_note'
  session_id: string
  session_file: string
  cwd: string
  chat_key: string
  source: string
  tool_name: string
  is_error: boolean
  summary: string
  text: string
  tags: string[]
}

type MemoryRelationEdge = {
  from: string
  to: string
  score: number
  reason: string
}

type MemoryRelationGraph = {
  updated_at: string
  edges: MemoryRelationEdge[]
}

export const RESIDENT_SLOTS = [
  'agent_identity',
  'owner_identity',
  'core_voice_style',
  'core_methodology',
  'core_values',
] as const

const RESIDENT_LIMITS: Record<string, { maxChars: number, fidelity: Array<MemoryFidelity> }> = {
  agent_identity: { maxChars: 500, fidelity: ['exact', 'fuzzy'] },
  owner_identity: { maxChars: 500, fidelity: ['exact', 'fuzzy'] },
  core_voice_style: { maxChars: 800, fidelity: ['fuzzy', 'exact'] },
  core_methodology: { maxChars: 800, fidelity: ['fuzzy', 'exact'] },
  core_values: { maxChars: 700, fidelity: ['fuzzy', 'exact'] },
}

const CHRONICLE_TAG = 'chronicle'
const EPISODE_TAG = 'episode'
const PROCESS_STATE_FILE = 'process-state.json'
const RELATIONS_STATE_FILE = 'relations.json'

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function nowIso(): string {
  return new Date().toISOString()
}

function trimText(value: unknown, max = 280): string {
  const text = safeString(value).replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueStrings(value.map((item) => safeString(item).trim()).filter(Boolean))
  return uniqueStrings(safeString(value).split(',').map((item) => item.trim()).filter(Boolean))
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = safeString(value).trim()
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function slugify(input: string, fallback = 'memory'): string {
  const base = safeString(input).trim().toLowerCase()
  const slug = base
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || fallback
}

function sha(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function normalizeNeedle(value: string): string {
  return safeString(value).toLowerCase().replace(/\s+/g, ' ').trim()
}

function cjkBigrams(value: string): string[] {
  const raw = safeString(value).replace(/\s+/g, '')
  const chars = [...raw].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char))
  const out: string[] = []
  for (let index = 0; index < chars.length - 1; index += 1) {
    out.push(`${chars[index]}${chars[index + 1]}`)
  }
  return uniqueStrings(out)
}

function latinTokens(value: string): string[] {
  return uniqueStrings(safeString(value)
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3))
}

function conceptTokens(value: string): string[] {
  return uniqueStrings([...latinTokens(value), ...cjkBigrams(value)])
}

function resolveAgentDir(): string {
  const fromEnv = safeString(process.env.PI_CODING_AGENT_DIR || process.env.RIN_DIR).trim()
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.rin')
}

export function resolveMemoryRoot(rootOverride = ''): string {
  if (safeString(rootOverride).trim()) return path.join(path.resolve(rootOverride), 'memory')
  return path.join(resolveAgentDir(), 'memory')
}

function ensureExposure(value: string, fallback: MemoryExposure = 'recall'): MemoryExposure {
  const normalized = safeString(value).trim()
  if (normalized === 'resident' || normalized === 'progressive' || normalized === 'recall') return normalized
  return fallback
}

function ensureFidelity(value: string, fallback: MemoryFidelity = 'fuzzy'): MemoryFidelity {
  const normalized = safeString(value).trim()
  if (normalized === 'exact' || normalized === 'fuzzy') return normalized
  return fallback
}

function ensureScope(value: string, fallback: MemoryScope = 'project'): MemoryScope {
  const normalized = safeString(value).trim()
  if (normalized === 'global' || normalized === 'domain' || normalized === 'project' || normalized === 'session') return normalized
  return fallback
}

function ensureKind(value: string, fallback: MemoryKind = 'knowledge'): MemoryKind {
  const normalized = safeString(value).trim()
  if (normalized === 'identity' || normalized === 'style' || normalized === 'method' || normalized === 'value' || normalized === 'preference' || normalized === 'rule' || normalized === 'knowledge' || normalized === 'history') return normalized
  return fallback
}

function ensureStatus(value: string, fallback: MemoryStatus = 'active'): MemoryStatus {
  const normalized = safeString(value).trim()
  if (normalized === 'active' || normalized === 'superseded' || normalized === 'invalidated') return normalized
  return fallback
}

function normalizeFrontmatter(raw: Record<string, any>, filePath: string, content: string): MemoryDoc {
  const exposure = ensureExposure(safeString(raw.exposure || 'recall'))
  const residentSlot = safeString(raw.resident_slot || '').trim()
  const title = safeString(raw.title || '').trim() || (residentSlot ? residentSlot.replace(/_/g, ' ') : path.basename(filePath, '.md'))
  const id = safeString(raw.id || '').trim() || slugify(title, path.basename(filePath, '.md'))
  return {
    id,
    title,
    exposure,
    fidelity: ensureFidelity(safeString(raw.fidelity || 'fuzzy')),
    resident_slot: residentSlot,
    summary: safeString(raw.summary || '').trim(),
    tags: normalizeList(raw.tags || ''),
    aliases: normalizeList(raw.aliases || ''),
    triggers: normalizeList(raw.triggers || ''),
    scope: ensureScope(safeString(raw.scope || (exposure === 'resident' ? 'global' : 'project'))),
    kind: ensureKind(safeString(raw.kind || (exposure === 'resident' ? 'preference' : 'knowledge'))),
    sensitivity: safeString(raw.sensitivity || 'normal').trim() || 'normal',
    source: safeString(raw.source || '').trim(),
    updated_at: safeString(raw.updated_at || '').trim() || nowIso(),
    last_observed_at: safeString(raw.last_observed_at || raw.updated_at || '').trim() || nowIso(),
    observation_count: Math.max(1, Number(raw.observation_count || 1) || 1),
    status: ensureStatus(safeString(raw.status || 'active')),
    supersedes: normalizeList(raw.supersedes || ''),
    canonical: raw.canonical == null ? exposure === 'resident' : Boolean(raw.canonical),
    path: filePath,
    content,
  }
}

function parseMarkdownDoc(filePath: string, text: string): MemoryDoc {
  const raw = safeString(text)
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return normalizeFrontmatter({}, filePath, raw.trim())
  let frontmatter: Record<string, any> = {}
  try {
    const parsed = parseYaml(match[1])
    if (parsed && typeof parsed === 'object') frontmatter = parsed as Record<string, any>
  } catch {}
  return normalizeFrontmatter(frontmatter, filePath, safeString(match[2]).trim())
}

function renderMarkdownDoc(doc: MemoryDoc): string {
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
    ...(doc.status && doc.status !== 'active' ? { status: doc.status } : {}),
    ...(doc.supersedes.length ? { supersedes: doc.supersedes } : {}),
    ...(doc.canonical ? { canonical: true } : {}),
  }
  const header = stringifyYaml(fm).trimEnd()
  return `---\n${header}\n---\n\n${safeString(doc.content).trim()}\n`
}

function previewMemoryDoc(doc: MemoryDoc): Record<string, any> {
  return {
    id: doc.id,
    title: doc.title,
    exposure: doc.exposure,
    fidelity: doc.fidelity,
    resident_slot: doc.resident_slot || undefined,
    summary: doc.summary,
    tags: doc.tags,
    aliases: doc.aliases,
    triggers: doc.triggers,
    scope: doc.scope,
    kind: doc.kind,
    sensitivity: doc.sensitivity,
    source: doc.source,
    updated_at: doc.updated_at,
    last_observed_at: doc.last_observed_at,
    observation_count: doc.observation_count,
    status: doc.status,
    supersedes: doc.supersedes,
    canonical: doc.canonical,
    path: doc.path,
  }
}

export async function ensureMemoryLayout(rootDir: string): Promise<void> {
  for (const rel of ['resident', 'progressive', 'recall', 'events', 'state']) {
    await fs.mkdir(path.join(rootDir, rel), { recursive: true })
  }
}

async function walkMarkdownFiles(dirPath: string): Promise<string[]> {
  if (!fssync.existsSync(dirPath)) return []
  const out: string[] = []
  const visit = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.md')) out.push(fullPath)
    }
  }
  await visit(dirPath)
  return out.sort()
}

export async function loadMemoryDocs(rootDir: string): Promise<MemoryDoc[]> {
  const files = await walkMarkdownFiles(rootDir)
  const docs: MemoryDoc[] = []
  for (const filePath of files) {
    const text = await fs.readFile(filePath, 'utf8')
    docs.push(parseMarkdownDoc(filePath, text))
  }
  return docs
}

function loadMemoryDocsSync(rootDir: string): MemoryDoc[] {
  const docs: MemoryDoc[] = []
  const visit = (dirPath: string) => {
    if (!fssync.existsSync(dirPath)) return
    for (const entry of fssync.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      try {
        docs.push(parseMarkdownDoc(fullPath, fssync.readFileSync(fullPath, 'utf8')))
      } catch {}
    }
  }
  visit(rootDir)
  return docs.sort((a, b) => safeString(a.path).localeCompare(safeString(b.path)))
}

function lexicalScore(query: string, doc: MemoryDoc): number {
  const q = normalizeNeedle(query)
  if (!q) return 0
  const haystack = normalizeNeedle([
    doc.title,
    doc.summary,
    doc.content,
    doc.id,
    doc.resident_slot,
    doc.scope,
    doc.kind,
    ...doc.tags,
    ...doc.aliases,
    ...doc.triggers,
  ].join(' \n '))
  if (!haystack) return 0
  let score = 0
  if (haystack.includes(q)) score += 6
  for (const token of q.split(/[^\p{Letter}\p{Number}_-]+/gu).filter((item) => item.length >= 2)) {
    if (haystack.includes(token)) score += token.length >= 4 ? 1.2 : 0.6
  }
  for (const token of cjkBigrams(q)) {
    if (haystack.includes(token)) score += 0.45
  }
  if (doc.id === q) score += 6
  if (doc.resident_slot === q) score += 6
  if (doc.exposure === 'progressive') score += 0.5
  if (doc.exposure === 'resident') score += 0.2
  if (doc.status !== 'active') score -= 8
  if (doc.tags.includes(CHRONICLE_TAG) && !/(history|timeline|recent|之前|最近|刚才|发生)/i.test(query)) score -= 1.4
  return score
}

function eventScore(query: string, event: MemoryEvent): number {
  const q = normalizeNeedle(query)
  if (!q) return 0
  const haystack = normalizeNeedle([
    event.kind,
    event.summary,
    event.text,
    event.tool_name,
    event.cwd,
    ...event.tags,
  ].join(' \n '))
  if (!haystack) return 0
  let score = 0
  if (haystack.includes(q)) score += 5
  for (const token of q.split(/[^\p{Letter}\p{Number}_-]+/gu).filter((item) => item.length >= 2)) {
    if (haystack.includes(token)) score += token.length >= 4 ? 1 : 0.5
  }
  for (const token of cjkBigrams(q)) {
    if (haystack.includes(token)) score += 0.35
  }
  const ageHours = Math.max(0, (Date.now() - Date.parse(event.created_at || nowIso())) / 3_600_000)
  score += Math.max(0, 2 - ageHours / 24)
  return score
}

async function resolveMemoryDoc(rootDir: string, query: string): Promise<MemoryDoc | null> {
  const raw = safeString(query).trim()
  if (!raw) return null
  const abs = path.isAbsolute(raw) ? raw : path.join(rootDir, raw)
  if (fssync.existsSync(abs) && abs.endsWith('.md')) return parseMarkdownDoc(abs, await fs.readFile(abs, 'utf8'))
  const docs = await loadMemoryDocs(rootDir)
  return docs.find((doc) => doc.id === raw || doc.resident_slot === raw) || null
}

function residentPath(rootDir: string, slot: string): string {
  return path.join(rootDir, 'resident', `${slot}.md`)
}

function genericDocPath(rootDir: string, exposure: MemoryExposure, id: string, subgroup = ''): string {
  return subgroup ? path.join(rootDir, exposure, subgroup, `${id}.md`) : path.join(rootDir, exposure, `${id}.md`)
}

function eventLogPath(rootDir: string, date = nowIso().slice(0, 10)): string {
  return path.join(rootDir, 'events', `${date}.jsonl`)
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

function sessionKey(meta: Partial<MemoryEvent>): string {
  const sessionFile = safeString(meta.session_file).trim()
  const sessionId = safeString(meta.session_id).trim()
  if (sessionFile) return slugify(path.basename(sessionFile, path.extname(sessionFile)), 'session')
  if (sessionId) return slugify(sessionId, 'session')
  return 'session'
}

function eventSummary(kind: MemoryEvent['kind'], text: string, toolName = '', isError = false): string {
  if (kind === 'tool_result') return `${toolName || 'tool'}${isError ? ' (error)' : ''}: ${trimText(text, 180)}`
  if (kind === 'assistant_message') return `assistant: ${trimText(text, 180)}`
  if (kind === 'user_input') return `user: ${trimText(text, 180)}`
  return trimText(text, 180)
}

function normalizeMessageText(text: string): string {
  return safeString(text).replace(/\r/g, '').trim()
}

function eventChronicleLine(event: MemoryEvent): string {
  const timestamp = safeString(event.created_at).slice(11, 16) || '??:??'
  return `- [${timestamp}] ${event.summary}`
}


function excerptForRecall(doc: MemoryDoc, query: string, max = 240): string {
  const text = [doc.summary, doc.content].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const q = safeString(query).trim().toLowerCase()
  if (!q || text.length <= max) return trimText(text, max)
  const idx = text.toLowerCase().indexOf(q)
  if (idx < 0) return trimText(text, max)
  const start = Math.max(0, idx - Math.floor(max / 3))
  const end = Math.min(text.length, start + max)
  const slice = text.slice(start, end).trim()
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`
}


function memoryRelationFeatures(doc: MemoryDoc): string[] {
  const contentSample = safeString(doc.content).split(/\n+/).slice(0, 12).join('\n')
  return uniqueStrings([
    ...conceptTokens(doc.title),
    ...conceptTokens(doc.summary),
    ...conceptTokens(contentSample),
    ...doc.tags.map((item) => normalizeNeedle(item)),
    ...doc.aliases.map((item) => normalizeNeedle(item)),
    ...doc.triggers.map((item) => normalizeNeedle(item)),
    normalizeNeedle(doc.scope),
    normalizeNeedle(doc.kind),
  ].filter(Boolean))
}

function relationScore(a: MemoryDoc, b: MemoryDoc): { score: number, reason: string } {
  const aFeatures = new Set(memoryRelationFeatures(a))
  const bFeatures = new Set(memoryRelationFeatures(b))
  let overlap = 0
  for (const feature of aFeatures) {
    if (bFeatures.has(feature)) overlap += 1
  }
  const sharedTags = a.tags.filter((item) => b.tags.some((other) => normalizeNeedle(other) === normalizeNeedle(item)))
  const sharedTriggers = a.triggers.filter((item) => b.triggers.some((other) => normalizeNeedle(other) === normalizeNeedle(item)))
  let score = Math.min(6, overlap) * 0.7 + sharedTags.length * 1.3 + sharedTriggers.length * 1.1
  if (a.scope && a.scope === b.scope) score += 0.5
  if (a.kind && a.kind === b.kind) score += 0.35
  if (a.exposure !== b.exposure) score += 0.25
  const reason = sharedTags.length
    ? 'shared-tags'
    : sharedTriggers.length
      ? 'shared-triggers'
      : overlap >= 3
        ? 'shared-concepts'
        : a.scope === b.scope
          ? 'shared-scope'
          : a.kind === b.kind
            ? 'shared-kind'
            : ''
  return { score, reason }
}

function shouldInjectRecentHistory(query: string): boolean {
  return /(history|timeline|recent|what happened|why did we|之前|最近|刚才|发生了什么|历史|时间线)/i.test(query)
}

function activeDocsOnly(docs: MemoryDoc[]): MemoryDoc[] {
  return docs.filter((doc) => doc.status === 'active')
}

function serializeEvent(record: MemoryEvent): string {
  return JSON.stringify(record)
}

function parseEventLine(line: string): MemoryEvent | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      id: safeString((parsed as any).id || ''),
      created_at: safeString((parsed as any).created_at || nowIso()),
      kind: ((parsed as any).kind || 'system_note') as any,
      session_id: safeString((parsed as any).session_id || ''),
      session_file: safeString((parsed as any).session_file || ''),
      cwd: safeString((parsed as any).cwd || ''),
      chat_key: safeString((parsed as any).chat_key || ''),
      source: safeString((parsed as any).source || ''),
      tool_name: safeString((parsed as any).tool_name || ''),
      is_error: Boolean((parsed as any).is_error),
      summary: safeString((parsed as any).summary || ''),
      text: safeString((parsed as any).text || ''),
      tags: normalizeList((parsed as any).tags || []),
    }
  } catch {
    return null
  }
}

async function loadEvents(rootDir: string, options: { since?: string, limit?: number } = {}): Promise<MemoryEvent[]> {
  const eventsDir = path.join(rootDir, 'events')
  if (!fssync.existsSync(eventsDir)) return []
  const files = (await fs.readdir(eventsDir)).filter((name) => name.endsWith('.jsonl')).sort()
  const out: MemoryEvent[] = []
  for (const name of files) {
    const text = await fs.readFile(path.join(eventsDir, name), 'utf8').catch(() => '')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      const event = parseEventLine(line)
      if (!event) continue
      if (options.since && safeString(event.created_at) <= safeString(options.since)) continue
      out.push(event)
    }
  }
  out.sort((a, b) => safeString(a.created_at).localeCompare(safeString(b.created_at)))
  if (options.limit && out.length > options.limit) return out.slice(-options.limit)
  return out
}

export async function logMemoryEvent(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const text = normalizeMessageText(safeString(params.text || params.summary || ''))
  const record: MemoryEvent = {
    id: safeString(params.id || `evt_${Date.now().toString(36)}_${sha(`${nowIso()}\n${text}\n${Math.random()}`).slice(0, 8)}`),
    created_at: safeString(params.created_at || nowIso()),
    kind: (safeString(params.kind || 'system_note') || 'system_note') as any,
    session_id: safeString(params.sessionId || params.session_id || '').trim(),
    session_file: safeString(params.sessionFile || params.session_file || '').trim(),
    cwd: safeString(params.cwd || '').trim(),
    chat_key: safeString(params.chatKey || params.chat_key || '').trim(),
    source: safeString(params.source || '').trim(),
    tool_name: safeString(params.toolName || params.tool_name || '').trim(),
    is_error: Boolean(params.isError || params.is_error),
    summary: trimText(params.summary || eventSummary((safeString(params.kind || 'system_note') || 'system_note') as any, text, safeString(params.toolName || params.tool_name || ''), Boolean(params.isError || params.is_error)), 220),
    text: trimText(text, 4000),
    tags: normalizeList(params.tags || []),
  }
  const filePath = eventLogPath(root, record.created_at.slice(0, 10))
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${serializeEvent(record)}\n`, 'utf8')
  return { status: 'ok', event: record }
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

function assertResidentDoc(doc: MemoryDoc): void {
  const slot = safeString(doc.resident_slot).trim()
  if (!RESIDENT_SLOTS.includes(slot as any)) throw new Error(`resident_slot_required:${RESIDENT_SLOTS.join(',')}`)
  const limits = RESIDENT_LIMITS[slot]
  if (!limits) throw new Error(`resident_slot_invalid:${slot}`)
  if (!limits.fidelity.includes(doc.fidelity)) throw new Error(`resident_fidelity_invalid:${slot}:${doc.fidelity}`)
  if (safeString(doc.content).trim().length > limits.maxChars) throw new Error(`resident_content_too_long:${slot}:${limits.maxChars}`)
}

async function writeMemoryDoc(doc: MemoryDoc) {
  await fs.mkdir(path.dirname(doc.path), { recursive: true })
  await fs.writeFile(doc.path, renderMarkdownDoc(doc), 'utf8')
}

async function appendChronicleEntry(rootDir: string, event: MemoryEvent) {
  const session = sessionKey(event)
  const date = safeString(event.created_at).slice(0, 10) || nowIso().slice(0, 10)
  const id = slugify(`${date}-${session}`, `${date}-session`)
  const filePath = genericDocPath(rootDir, 'recall', id, 'chronicles')
  const existing = fssync.existsSync(filePath) ? parseMarkdownDoc(filePath, await fs.readFile(filePath, 'utf8')) : normalizeFrontmatter({
    id,
    title: `${date} ${session} chronicle`,
    exposure: 'recall',
    fidelity: 'exact',
    summary: `Chronological memory chronicle for ${session} on ${date}.`,
    tags: [CHRONICLE_TAG, session],
    triggers: ['history', 'timeline', 'recent'],
    scope: 'session',
    kind: 'history',
    source: 'memory:event-ledger',
  }, filePath, '')
  const marker = `<!-- event:${event.id} -->`
  if (existing.content.includes(marker)) return false
  const line = eventChronicleLine(event)
  existing.path = filePath
  existing.updated_at = nowIso()
  existing.tags = uniqueStrings([...existing.tags, CHRONICLE_TAG, session])
  existing.triggers = uniqueStrings([...existing.triggers, 'history', 'timeline', 'recent'])
  existing.scope = 'session'
  existing.kind = 'history'
  existing.summary = `Chronological memory chronicle for ${session} on ${date}.`
  existing.content = [existing.content.trim(), marker, line].filter(Boolean).join('\n')
  await writeMemoryDoc(existing)
  return true
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
  return { root, count: results.length, results: results.map(previewMemoryDoc) }
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

function residentPromptLine(slot: string, body: string): string {
  const text = safeString(body).trim()
  if (!text) return ''
  return `[${slot}] ${text}`
}

function progressiveIndexLine(doc: MemoryDoc): string {
  const desc = trimText(doc.summary || excerptForRecall(doc, '', 160) || 'Read this when relevant.', 180)
  return `- ${doc.title}: ${desc}`
}

function renderExpandedDoc(doc: MemoryDoc): string {
  return [`### ${doc.title}`, safeString(doc.content).trim()].filter(Boolean).join('\n\n')
}

function renderRecallContext(doc: MemoryDoc, query: string): string {
  const excerpt = excerptForRecall(doc, query, 260)
  const meta = [doc.scope, doc.kind].filter(Boolean).join(' • ')
  return [`- ${doc.title}${meta ? ` — ${meta}` : ''}`, excerpt].filter(Boolean).join('\n  ')
}

function renderRelatedContext(doc: MemoryDoc, reason: string, query: string): string {
  const excerpt = excerptForRecall(doc, query, 180)
  return [`- ${doc.title} (${reason || 'related'})`, excerpt].filter(Boolean).join('\n  ')
}

function renderHistoryEvent(event: MemoryEvent): string {
  return `- [${safeString(event.created_at).slice(0, 16).replace('T', ' ')}] ${event.summary}`
}

function compileFromDocsAndEvents(docs: MemoryDoc[], events: MemoryEvent[], graph: MemoryRelationGraph, params: Record<string, any> = {}, root = '') {
  const query = safeString(params.query || '').trim()
  const resident = docs
    .filter((doc) => doc.exposure === 'resident' && doc.canonical && RESIDENT_SLOTS.includes(doc.resident_slot as any))
    .sort((a, b) => RESIDENT_SLOTS.indexOf(a.resident_slot as any) - RESIDENT_SLOTS.indexOf(b.resident_slot as any))
  const progressiveDocs = docs
    .filter((doc) => doc.exposure === 'progressive')
    .sort((a, b) => safeString(b.updated_at).localeCompare(safeString(a.updated_at)))
  const progressiveIndexLimit = Math.max(0, Number(params.progressiveLimit == null ? 12 : params.progressiveLimit) || 12)
  const expandedProgressiveLimit = Math.max(0, Number(params.expandedProgressiveLimit == null ? 2 : params.expandedProgressiveLimit) || 2)
  const recallLimit = Math.max(0, Number(params.recallLimit == null ? 3 : params.recallLimit) || 3)
  const historyLimit = Math.max(0, Number(params.historyLimit == null ? 3 : params.historyLimit) || 3)

  const expandedProgressives = !query ? [] : progressiveDocs
    .map((doc) => ({ doc, score: lexicalScore(query, doc) + (doc.scope === 'domain' ? 0.4 : 0) }))
    .filter((row) => row.score >= 0.9)
    .sort((a, b) => b.score - a.score || safeString(b.doc.updated_at).localeCompare(safeString(a.doc.updated_at)))
    .slice(0, expandedProgressiveLimit)
    .map((row) => row.doc)

  const episodeDocs = !query ? [] : docs
    .filter((doc) => doc.exposure === 'recall' && doc.tags.includes(EPISODE_TAG))
    .map((doc) => ({ doc, score: lexicalScore(query, doc) + 0.8 }))
    .filter((row) => row.score >= 1.1)
    .sort((a, b) => b.score - a.score || safeString(b.doc.updated_at).localeCompare(safeString(a.doc.updated_at)))
    .slice(0, 2)
    .map((row) => row.doc)

  const recallDocs = !query ? [] : docs
    .filter((doc) => doc.exposure === 'recall')
    .filter((doc) => !doc.tags.includes(EPISODE_TAG))
    .filter((doc) => episodeDocs.length === 0 || !doc.tags.includes(CHRONICLE_TAG))
    .filter((doc) => shouldInjectRecentHistory(query) || !doc.tags.includes(CHRONICLE_TAG))
    .map((doc) => ({ doc, score: lexicalScore(query, doc) }))
    .filter((row) => row.score >= 1.2)
    .sort((a, b) => b.score - a.score || safeString(b.doc.updated_at).localeCompare(safeString(a.doc.updated_at)))
    .slice(0, recallLimit)
    .map((row) => row.doc)

  const relatedDocs = (() => {
    if (!query) return [] as Array<{ reason: string, doc: MemoryDoc }>
    const seen = new Set<string>()
    const out: Array<{ reason: string, doc: MemoryDoc, score: number }> = []
    for (const edge of graph.edges) {
      if (![...expandedProgressives, ...recallDocs, ...episodeDocs].some((doc) => doc.id === edge.from)) continue
      const doc = docs.find((item) => item.id === edge.to)
      if (!doc) continue
      if (episodeDocs.length > 0 && doc.tags.includes(CHRONICLE_TAG)) continue
      if (recallDocs.some((item) => item.id === doc.id) || episodeDocs.some((item) => item.id === doc.id) || expandedProgressives.some((item) => item.id === doc.id)) continue
      if (seen.has(doc.id)) continue
      seen.add(doc.id)
      out.push({ reason: edge.reason, doc, score: edge.score })
      if (out.length >= 3) break
    }
    return out.sort((a, b) => b.score - a.score).map((row) => ({ reason: row.reason, doc: row.doc }))
  })()

  const history = !query || !shouldInjectRecentHistory(query) ? [] : events
    .map((event) => ({ event, score: eventScore(query, event) }))
    .filter((row) => row.score >= 1.2)
    .sort((a, b) => b.score - a.score || safeString(b.event.created_at).localeCompare(safeString(a.event.created_at)))
    .slice(0, historyLimit)
    .map((row) => row.event)

  return {
    root,
    query,
    resident_slots: RESIDENT_SLOTS,
    resident: resident.map((doc) => residentPromptLine(doc.resident_slot, doc.content)).filter(Boolean).join('\n'),
    progressive_index: progressiveDocs.slice(0, progressiveIndexLimit).map(progressiveIndexLine).join('\n'),
    progressive_expanded: expandedProgressives.map(renderExpandedDoc).join('\n\n'),
    episode_context: episodeDocs.map((doc) => renderExpandedDoc(doc)).join('\n\n'),
    recall_context: recallDocs.map((doc) => renderRecallContext(doc, query)).join('\n\n'),
    related_context: relatedDocs.map((row) => renderRelatedContext(row.doc, row.reason, query)).join('\n\n'),
    recent_history: history.map(renderHistoryEvent).join('\n'),
    resident_docs: resident.map(previewMemoryDoc),
    progressive_docs: progressiveDocs.slice(0, progressiveIndexLimit).map(previewMemoryDoc),
    expanded_progressives: expandedProgressives.map(previewMemoryDoc),
    episode_docs: episodeDocs.map(previewMemoryDoc),
    recall_docs: recallDocs.map(previewMemoryDoc),
    related_docs: relatedDocs.map((row) => ({ reason: row.reason, ...previewMemoryDoc(row.doc) })),
    history_events: history,
  }
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
