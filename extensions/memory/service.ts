import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

export type MemoryExposure = 'resident' | 'progressive' | 'recall'
export type MemoryFidelity = 'exact' | 'fuzzy'

export type MemoryDoc = {
  id: string
  title: string
  exposure: MemoryExposure
  fidelity: MemoryFidelity
  resident_slot: string
  summary: string
  tags: string[]
  aliases: string[]
  sensitivity: string
  source: string
  updated_at: string
  canonical: boolean
  path: string
  content: string
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

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => safeString(item).trim()).filter(Boolean)
  return safeString(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function slugify(input: string, fallback = 'memory'): string {
  const base = safeString(input).trim().toLowerCase()
  const slug = base
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || fallback
}

function sha(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
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
    sensitivity: safeString(raw.sensitivity || 'normal').trim() || 'normal',
    source: safeString(raw.source || '').trim(),
    updated_at: safeString(raw.updated_at || '').trim() || nowIso(),
    canonical: Boolean(raw.canonical),
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
    ...(doc.sensitivity ? { sensitivity: doc.sensitivity } : {}),
    ...(doc.source ? { source: doc.source } : {}),
    updated_at: doc.updated_at || nowIso(),
    ...(doc.canonical ? { canonical: true } : {}),
  }
  const header = stringifyYaml(fm).trimEnd()
  return `---\n${header}\n---\n\n${safeString(doc.content).trim()}\n`
}

export async function ensureMemoryLayout(rootDir: string): Promise<void> {
  for (const rel of ['resident', 'progressive', 'recall']) {
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

export function loadMemoryDocsSync(rootDir: string): MemoryDoc[] {
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
      let text = ''
      try { text = fssync.readFileSync(fullPath, 'utf8') } catch { continue }
      docs.push(parseMarkdownDoc(fullPath, text))
    }
  }
  visit(rootDir)
  return docs.sort((a, b) => safeString(a.path).localeCompare(safeString(b.path)))
}

function normalizeNeedle(value: string): string {
  return safeString(value).toLowerCase().replace(/\s+/g, ' ').trim()
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
    ...doc.tags,
    ...doc.aliases,
  ].join(' \n '))
  if (!haystack) return 0
  let score = 0
  if (haystack.includes(q)) score += 5
  for (const token of q.split(/[^\p{Letter}\p{Number}_-]+/gu).filter((item) => item.length >= 2)) {
    if (haystack.includes(token)) score += token.length >= 4 ? 1.2 : 0.6
  }
  if (doc.id === q) score += 6
  if (doc.resident_slot === q) score += 6
  return score
}

export function previewMemoryDoc(doc: MemoryDoc): Record<string, any> {
  return {
    id: doc.id,
    title: doc.title,
    exposure: doc.exposure,
    fidelity: doc.fidelity,
    resident_slot: doc.resident_slot || undefined,
    summary: doc.summary,
    tags: doc.tags,
    aliases: doc.aliases,
    sensitivity: doc.sensitivity,
    source: doc.source,
    updated_at: doc.updated_at,
    canonical: doc.canonical,
    path: doc.path,
  }
}

export async function resolveMemoryDoc(rootDir: string, query: string): Promise<MemoryDoc | null> {
  const raw = safeString(query).trim()
  if (!raw) return null
  const abs = path.isAbsolute(raw) ? raw : path.join(rootDir, raw)
  if (fssync.existsSync(abs) && abs.endsWith('.md')) {
    return parseMarkdownDoc(abs, await fs.readFile(abs, 'utf8'))
  }
  const docs = await loadMemoryDocs(rootDir)
  return docs.find((doc) => doc.id === raw || doc.resident_slot === raw) || null
}

function residentPath(rootDir: string, slot: string): string {
  return path.join(rootDir, 'resident', `${slot}.md`)
}

function genericDocPath(rootDir: string, exposure: MemoryExposure, id: string): string {
  return path.join(rootDir, exposure, `${id}.md`)
}

function resolveMemoryIndexRoot(rootOverride = ''): string {
  if (safeString(rootOverride).trim()) return path.join(path.resolve(rootOverride), 'data', 'memory-index')
  return path.join(resolveAgentDir(), 'data', 'memory-index')
}

function memoryManifestPath(rootOverride = ''): string {
  return path.join(resolveMemoryIndexRoot(rootOverride), 'manifest.json')
}

function memoryLanceDir(rootOverride = ''): string {
  return path.join(resolveMemoryIndexRoot(rootOverride), 'lancedb')
}

class SharedMemoryEmbeddings {
  private static instance: SharedMemoryEmbeddings | null = null
  private embedder: any
  private initialized = false
  readonly model: string
  readonly dims: number

  private constructor() {
    this.model = process.env.RIN_MEMORY_EMBED_MODEL || process.env.RIN_EMBED_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
    this.dims = Number(process.env.RIN_MEMORY_EMBED_DIMS || process.env.RIN_EMBED_DIMS || '384')
  }

  static get(): SharedMemoryEmbeddings {
    if (!SharedMemoryEmbeddings.instance) SharedMemoryEmbeddings.instance = new SharedMemoryEmbeddings()
    return SharedMemoryEmbeddings.instance
  }

  async init(): Promise<void> {
    if (this.initialized) return
    const embeddingModule: any = await dynamicImport('@lancedb/lancedb/embedding/transformers')
    const transformers: any = await dynamicImport('@huggingface/transformers')
    transformers.env.cacheDir = process.env.RIN_EMBED_CACHE_DIR || path.join(os.homedir(), '.cache', 'rin-memory', 'transformers')
    await fs.mkdir(transformers.env.cacheDir, { recursive: true })
    const TransformersEmbeddingFunction = embeddingModule.TransformersEmbeddingFunction
    this.embedder = new TransformersEmbeddingFunction({ model: this.model, ndims: this.dims })
    await this.embedder.init()
    this.initialized = true
  }

  async embedQuery(text: string): Promise<number[]> {
    await this.init()
    return await this.embedder.computeQueryEmbeddings(text)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.init()
    return await this.embedder.computeSourceEmbeddings(texts)
  }
}

function memoryVectorText(doc: MemoryDoc): string {
  return [doc.title, doc.summary, doc.content, doc.tags.join(' '), doc.aliases.join(' ')].filter(Boolean).join('\n\n').trim()
}

function memoryManifestFromDocs(docs: MemoryDoc[]) {
  return docs.map((doc) => ({
    path: doc.path,
    id: doc.id,
    updated_at: doc.updated_at,
    hash: sha(`${doc.path}\n${doc.updated_at}\n${doc.title}\n${doc.summary}\n${doc.content}`),
  }))
}

async function ensureMemoryVectorIndex(root: string, docs: MemoryDoc[]): Promise<{ indexed: boolean, count: number, model?: string, dims?: number }> {
  const { connect }: any = await dynamicImport('@lancedb/lancedb')
  const indexRoot = resolveMemoryIndexRoot(path.dirname(root))
  const manifestPath = memoryManifestPath(path.dirname(root))
  const lanceDir = memoryLanceDir(path.dirname(root))
  const nextManifest = memoryManifestFromDocs(docs)
  let currentManifest: any[] = []
  try { currentManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) } catch {}
  const unchanged = JSON.stringify(currentManifest) === JSON.stringify(nextManifest)
  const embeddings = SharedMemoryEmbeddings.get()
  if (unchanged && fssync.existsSync(lanceDir)) {
    return { indexed: false, count: docs.length, model: embeddings.model, dims: embeddings.dims }
  }
  await fs.mkdir(indexRoot, { recursive: true })
  await fs.rm(lanceDir, { recursive: true, force: true })
  const rows = docs.map((doc) => ({
    id: doc.id,
    path: doc.path,
    title: doc.title,
    summary: doc.summary,
    text: memoryVectorText(doc),
    updated_at: doc.updated_at,
    exposure: doc.exposure,
    fidelity: doc.fidelity,
    resident_slot: doc.resident_slot,
  }))
  if (!rows.length) {
    await fs.writeFile(manifestPath, JSON.stringify(nextManifest, null, 2), 'utf8')
    return { indexed: true, count: 0, model: embeddings.model, dims: embeddings.dims }
  }
  const vectors = await embeddings.embedBatch(rows.map((row) => row.text))
  const conn = await connect(lanceDir)
  const table = await conn.createTable('memory', rows.map((row, index) => ({ ...row, vector: vectors[index] || [] })), { mode: 'overwrite' })
  try { await table.createIndex('vector', { replace: true }) } catch {}
  await fs.writeFile(manifestPath, JSON.stringify(nextManifest, null, 2), 'utf8')
  return { indexed: true, count: rows.length, model: embeddings.model, dims: embeddings.dims }
}

async function searchMemoryVectors(root: string, query: string, limit: number): Promise<any[]> {
  const { connect }: any = await dynamicImport('@lancedb/lancedb')
  const lanceDir = memoryLanceDir(path.dirname(root))
  if (!fssync.existsSync(lanceDir)) return []
  const embeddings = SharedMemoryEmbeddings.get()
  const conn = await connect(lanceDir)
  let table: any = null
  try { table = await conn.openTable('memory') } catch { return [] }
  const vector = await embeddings.embedQuery(query)
  return await (table.search(vector, 'vector') as any)
    .select(['id', 'path', 'title', 'summary', 'updated_at', 'exposure', 'fidelity', 'resident_slot', '_distance'])
    .limit(limit)
    .toArray()
}

function assertResidentDoc(doc: MemoryDoc): void {
  const slot = safeString(doc.resident_slot).trim()
  if (!RESIDENT_SLOTS.includes(slot as any)) throw new Error(`resident_slot_required:${RESIDENT_SLOTS.join(',')}`)
  const limits = RESIDENT_LIMITS[slot]
  if (!limits) throw new Error(`resident_slot_invalid:${slot}`)
  if (!limits.fidelity.includes(doc.fidelity)) throw new Error(`resident_fidelity_invalid:${slot}:${doc.fidelity}`)
  if (safeString(doc.content).trim().length > limits.maxChars) throw new Error(`resident_content_too_long:${slot}:${limits.maxChars}`)
}

function residentPromptLine(slot: string, body: string): string {
  const text = safeString(body).trim()
  if (!text) return ''
  return `[${slot}] ${text}`
}

function progressiveCard(doc: MemoryDoc): string {
  const tags = doc.tags.length ? ` tags=${doc.tags.join(',')}` : ''
  return `- ${doc.title}: ${doc.summary || 'Read this note when relevant.'}${tags} path=${doc.path}`
}

export async function listMemories(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const exposureFilter = safeString(params.exposure || '').trim()
  const slotFilter = safeString(params.residentSlot || '').trim()
  const limit = Math.max(1, Number(params.limit || 200) || 200)
  const results = (await loadMemoryDocs(root))
    .filter((doc) => !exposureFilter || doc.exposure === exposureFilter)
    .filter((doc) => !slotFilter || doc.resident_slot === slotFilter)
    .sort((a, b) => safeString(b.updated_at).localeCompare(safeString(a.updated_at)))
    .slice(0, limit)
  return { root, count: results.length, results: results.map(previewMemoryDoc) }
}

export async function searchMemories(query: string, params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const exposureFilter = safeString(params.exposure || '').trim()
  const limit = Math.max(1, Number(params.limit || 20) || 20)
  const docs = (await loadMemoryDocs(root)).filter((doc) => !exposureFilter || doc.exposure === exposureFilter)
  const lexical = docs
    .map((doc) => ({ doc, score: lexicalScore(query, doc), lexical: lexicalScore(query, doc) }))
    .filter((row) => row.score > 0)
  let vectorRows: any[] = []
  let vectorStatus: any = { enabled: true, used: false }
  try {
    const indexState = await ensureMemoryVectorIndex(root, docs)
    vectorRows = await searchMemoryVectors(root, query, Math.max(limit * 2, 8))
    vectorStatus = { enabled: true, used: true, ...indexState }
  } catch (error: any) {
    vectorStatus = { enabled: false, error: safeString(error?.message || error) }
  }
  const merged = new Map<string, any>()
  for (const row of lexical) {
    merged.set(row.doc.path, {
      doc: row.doc,
      score: row.score,
      lexical: row.lexical,
      vector: 0,
    })
  }
  for (const row of vectorRows) {
    const doc = docs.find((item) => item.path === safeString(row.path))
    if (!doc) continue
    const distance = Number(row._distance)
    const vectorScore = Number.isFinite(distance) ? Math.max(0, 2.5 - distance) : 0
    const existing = merged.get(doc.path) || { doc, score: 0, lexical: 0, vector: 0 }
    existing.vector = Math.max(Number(existing.vector || 0), vectorScore)
    existing.score = Math.max(Number(existing.score || 0), Number(existing.lexical || 0) + vectorScore)
    merged.set(doc.path, existing)
  }
  const results = [...merged.values()]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || safeString(b.doc.updated_at).localeCompare(safeString(a.doc.updated_at)))
    .slice(0, limit)
  return {
    query,
    count: results.length,
    vector: vectorStatus,
    results: results.map((row) => ({
      score: Number(row.score || 0),
      lexical: Number(row.lexical || 0),
      vector: Number(row.vector || 0),
      ...previewMemoryDoc(row.doc),
    })),
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
  const title = safeString(params.title || '').trim() || content.split(/\r?\n/)[0].trim().slice(0, 64) || 'memory'
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
    sensitivity: safeString(params.sensitivity || 'normal').trim() || 'normal',
    source: safeString(params.source || '').trim(),
    updated_at: nowIso(),
    canonical: exposure === 'resident',
    path: '',
    content,
  }
  if (exposure === 'resident') {
    assertResidentDoc(doc)
    doc.path = residentPath(root, doc.resident_slot)
  } else {
    doc.path = genericDocPath(root, exposure, doc.id)
  }
  await fs.mkdir(path.dirname(doc.path), { recursive: true })
  await fs.writeFile(doc.path, renderMarkdownDoc(doc), 'utf8')
  try { await ensureMemoryVectorIndex(root, await loadMemoryDocs(root)) } catch {}
  return { status: 'ok', action: 'save', doc: previewMemoryDoc(doc) }
}

export async function deleteMemory(target: string, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const doc = await resolveMemoryDoc(root, target)
  if (!doc) throw new Error(`memory_not_found:${target}`)
  await fs.rm(doc.path, { force: true })
  try { await ensureMemoryVectorIndex(root, await loadMemoryDocs(root)) } catch {}
  return { status: 'ok', action: 'delete', id: doc.id, path: doc.path }
}

function compileFromDocs(docs: MemoryDoc[], params: Record<string, any> = {}, root = '') {
  const section = safeString(params.section || 'all').trim() || 'all'
  const progressiveLimit = Math.max(0, Number(params.progressiveLimit == null ? 12 : params.progressiveLimit) || 12)
  const resident = docs
    .filter((doc) => doc.exposure === 'resident' && doc.canonical && RESIDENT_SLOTS.includes(doc.resident_slot as any))
    .sort((a, b) => RESIDENT_SLOTS.indexOf(a.resident_slot as any) - RESIDENT_SLOTS.indexOf(b.resident_slot as any))
  const progressive = docs
    .filter((doc) => doc.exposure === 'progressive')
    .sort((a, b) => safeString(b.updated_at).localeCompare(safeString(a.updated_at)))
    .slice(0, progressiveLimit)
  return {
    root,
    resident_slots: RESIDENT_SLOTS,
    resident: section === 'progressive' ? '' : resident.map((doc) => residentPromptLine(doc.resident_slot, doc.content)).filter(Boolean).join('\n'),
    progressive: section === 'resident' ? '' : progressive.map((doc) => progressiveCard(doc)).join('\n'),
    resident_docs: resident.map(previewMemoryDoc),
    progressive_docs: progressive.map(previewMemoryDoc),
  }
}

export async function compileMemory(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const docs = await loadMemoryDocs(root)
  return compileFromDocs(docs, params, root)
}

export function compileMemorySync(params: Record<string, any> = {}, rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  if (!fssync.existsSync(root)) return compileFromDocs([], params, root)
  return compileFromDocs(loadMemoryDocsSync(root), params, root)
}

export async function doctorMemory(rootOverride = '') {
  const root = resolveMemoryRoot(rootOverride)
  await ensureMemoryLayout(root)
  const docs = await loadMemoryDocs(root)
  const counts = { resident: 0, progressive: 0, recall: 0 }
  for (const doc of docs) counts[doc.exposure] += 1
  let vector: any = { enabled: false }
  try {
    const embeddings = SharedMemoryEmbeddings.get()
    vector = {
      enabled: true,
      model: embeddings.model,
      dims: embeddings.dims,
      index_root: resolveMemoryIndexRoot(rootOverride),
      lance_dir: memoryLanceDir(rootOverride),
      manifest_path: memoryManifestPath(rootOverride),
      manifest_exists: fssync.existsSync(memoryManifestPath(rootOverride)),
      lance_exists: fssync.existsSync(memoryLanceDir(rootOverride)),
    }
  } catch (error: any) {
    vector = { enabled: false, error: safeString(error?.message || error) }
  }
  return {
    root,
    resident_slots: RESIDENT_SLOTS,
    counts,
    total: docs.length,
    resident_missing_slots: RESIDENT_SLOTS.filter((slot) => !docs.some((doc) => doc.exposure === 'resident' && doc.resident_slot === slot)),
    vector,
  }
}

export async function executeMemoryAction(params: Record<string, any> = {}, rootOverride = '') {
  const action = safeString(params.action || '').trim()
  if (action === 'list') return await listMemories(params, rootOverride)
  if (action === 'search') return await searchMemories(safeString(params.query || ''), params, rootOverride)
  if (action === 'get') return await getMemory(safeString(params.path || params.id || params.query || ''), rootOverride)
  if (action === 'save') return await saveMemory(params, rootOverride)
  if (action === 'delete') return await deleteMemory(safeString(params.path || params.id || params.query || ''), rootOverride)
  if (action === 'compile') return await compileMemory(params, rootOverride)
  if (action === 'doctor') return await doctorMemory(rootOverride)
  throw new Error(`unsupported_memory_action:${action}`)
}
