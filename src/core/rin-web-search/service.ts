// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'

const USER_AGENT = 'Rin web search/1.0'
const START_TIMEOUT_MS = 90_000
const SEARCH_TIMEOUT_MS = 8_000
const RIN_WEB_SEARCH_BASE_URL_ENV = 'RIN_WEB_SEARCH_BASE_URL'

type WebSearchRequest = {
  q: string
  limit?: number
  domains?: string[]
  freshness?: 'day' | 'week' | 'month' | 'year'
  language?: string
}

type WebSearchResponse = {
  ok: boolean
  query: string
  results: Array<Record<string, any>>
  engine?: string
  attempts?: Array<Record<string, any>>
  error?: string
}

function safeString(v: unknown): string {
  if (v == null) return ''
  return String(v)
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function ensurePrivateDir(dir: string) {
  ensureDir(dir)
  try { fs.chmodSync(dir, 0o700) } catch {}
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600) {
  ensurePrivateDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode })
  fs.renameSync(tmp, filePath)
  try { fs.chmodSync(filePath, mode) } catch {}
}

function findExecutableOnPath(name: string): string {
  const raw = safeString(process.env.PATH)
  const parts = raw ? raw.split(path.delimiter) : []
  for (const dir of parts) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return ''
}

function isPidAlive(pid: unknown): boolean {
  const n = Number(pid || 0)
  if (!Number.isFinite(n) || n <= 1) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeText(value: unknown): string {
  if (value == null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function dataRootForState(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), 'data', 'web-search')
}

function runtimeRootForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), 'runtime')
}

function instancesRootForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), 'instances')
}

function runtimeLockPathForState(stateRoot: string): string {
  return path.join(runtimeRootForState(stateRoot), 'install.lock')
}

function runtimeSourceDirForState(stateRoot: string): string {
  return path.join(runtimeRootForState(stateRoot), 'src')
}

function runtimeVenvDirForState(stateRoot: string): string {
  return path.join(runtimeRootForState(stateRoot), 'venv')
}

function runtimeTmpDirForState(stateRoot: string): string {
  return path.join(runtimeRootForState(stateRoot), 'tmp')
}

function runtimeBootstrapStateFileForState(stateRoot: string): string {
  return path.join(runtimeRootForState(stateRoot), 'bootstrap.json')
}

function runtimePythonBinForState(stateRoot: string): string {
  const dir = runtimeVenvDirForState(stateRoot)
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python')
}

function runtimePipBinForState(stateRoot: string): string {
  const dir = runtimeVenvDirForState(stateRoot)
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'pip.exe') : path.join(dir, 'bin', 'pip')
}

function instanceRootForState(stateRoot: string, instanceId: string): string {
  return path.join(instancesRootForState(stateRoot), instanceId)
}

function instanceStateFileForState(stateRoot: string, instanceId: string): string {
  return path.join(instanceRootForState(stateRoot, instanceId), 'state.json')
}

function instanceSettingsFileForState(stateRoot: string, instanceId: string): string {
  return path.join(instanceRootForState(stateRoot, instanceId), 'settings.yml')
}

function readRuntimeBootstrapState(stateRoot: string) {
  return readJson<any>(runtimeBootstrapStateFileForState(stateRoot), null)
}

function writeRuntimeBootstrapState(stateRoot: string, value: any) {
  writeJsonAtomic(runtimeBootstrapStateFileForState(stateRoot), value)
}

function readInstanceState(stateRoot: string, instanceId: string) {
  return readJson<any>(instanceStateFileForState(stateRoot, instanceId), null)
}

function listInstanceIds(stateRoot: string) {
  try {
    return fs.readdirSync(instancesRootForState(stateRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function writeInstanceState(stateRoot: string, instanceId: string, value: any) {
  writeJsonAtomic(instanceStateFileForState(stateRoot, instanceId), value)
}

function runCommandSync(command: string, args: string[], options: any = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  if (result.status === 0) return result
  const detail = safeText(result.stderr || result.stdout || result.error?.message || `exit_${result.status}`)
  throw new Error(`${path.basename(command)}:${detail}`)
}

async function acquireFileLock(lockPath: string, timeoutMs = 20_000) {
  ensurePrivateDir(path.dirname(lockPath))
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }))
      try { fs.closeSync(fd) } catch {}
      return () => { try { fs.rmSync(lockPath, { force: true }) } catch {} }
    } catch {
      let stale = false
      try {
        const state = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
        if (!isPidAlive(Number(state?.pid || 0))) stale = true
      } catch {
        stale = true
      }
      if (stale) {
        try { fs.rmSync(lockPath, { force: true }) } catch {}
        continue
      }
      await sleep(100)
    }
  }
  throw new Error(`web_search_lock_timeout:${lockPath}`)
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? Number(address.port || 0) : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
    server.on('error', reject)
  })
}

function writeSearxngSettingsForInstance(stateRoot: string, instanceId: string, baseUrl: string, port: number) {
  const settingsPath = instanceSettingsFileForState(stateRoot, instanceId)
  ensurePrivateDir(path.dirname(settingsPath))
  const secret = crypto.createHash('sha256').update(`${baseUrl}|${stateRoot}|${instanceId}|rin-web-search`).digest('hex').slice(0, 32)
  const yaml = [
    'use_default_settings: true',
    '',
    'general:',
    '  enable_metrics: false',
    '',
    'search:',
    '  formats:',
    '    - html',
    '    - json',
    '',
    'server:',
    `  port: ${port}`,
    '  bind_address: "127.0.0.1"',
    `  base_url: ${JSON.stringify(`${baseUrl}/`)}`,
    `  secret_key: ${JSON.stringify(secret)}`,
    '  limiter: false',
    '  public_instance: false',
    '',
    'valkey:',
    '  url: false',
    '',
  ].join('\n')
  fs.writeFileSync(settingsPath, yaml, { mode: 0o600 })
  return settingsPath
}

function ensureSearxngRuntimeInstalled(stateRoot: string, logger?: any) {
  const runtimeDir = runtimeRootForState(stateRoot)
  const sourceDir = runtimeSourceDirForState(stateRoot)
  const venvDir = runtimeVenvDirForState(stateRoot)
  const tmpDir = runtimeTmpDirForState(stateRoot)
  const pythonBin = runtimePythonBinForState(stateRoot)
  const pipBin = runtimePipBinForState(stateRoot)
  const current = readRuntimeBootstrapState(stateRoot)
  if (current?.ready && fs.existsSync(sourceDir) && fs.existsSync(pythonBin) && fs.existsSync(pipBin)) {
    return { sourceDir, pythonBin, pipBin, reused: true }
  }

  ensurePrivateDir(runtimeDir)
  ensurePrivateDir(tmpDir)

  const python = findExecutableOnPath('python3') || findExecutableOnPath('python')
  if (!python) throw new Error('python_not_found')
  const git = findExecutableOnPath('git')
  if (!git) throw new Error('git_not_found')

  if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    try { fs.rmSync(sourceDir, { recursive: true, force: true }) } catch {}
    try { logger?.info?.('web-search: cloning searxng source') } catch {}
    runCommandSync(git, ['clone', '--depth', '1', 'https://github.com/searxng/searxng.git', sourceDir], { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } })
  }

  if (!fs.existsSync(pythonBin)) {
    try { logger?.info?.('web-search: creating searxng virtualenv') } catch {}
    runCommandSync(python, ['-m', 'venv', venvDir], { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } })
  }

  try { logger?.info?.('web-search: installing searxng runtime dependencies') } catch {}
  runCommandSync(pipBin, ['install', '--upgrade', 'pip', 'wheel', 'setuptools'], { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } })
  runCommandSync(pipBin, ['install', '-r', path.join(sourceDir, 'requirements.txt')], { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } })
  runCommandSync(pipBin, ['install', '--no-build-isolation', '-e', sourceDir], { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } })

  writeRuntimeBootstrapState(stateRoot, {
    ready: true,
    sourceDir,
    pythonBin,
    pipBin,
    installedAt: new Date().toISOString(),
  })
  return { sourceDir, pythonBin, pipBin, reused: false }
}

function resolveWebSearchBaseUrl() {
  return safeString(process.env[RIN_WEB_SEARCH_BASE_URL_ENV]).trim()
}

function createInstanceId(prefix = 'ws') {
  const rand = crypto.randomBytes(6).toString('hex')
  return `${prefix}-${process.pid}-${rand}`
}

async function ensureSearxngSidecar(stateRoot: string, options: { logger?: any; timeoutMs?: number; instanceId?: string } = {}) {
  const logger = options.logger
  const instanceId = safeString(options.instanceId).trim() || createInstanceId('searxng')
  const existing = readInstanceState(stateRoot, instanceId)
  if (existing?.pid && isPidAlive(Number(existing.pid)) && safeString(existing.baseUrl).trim()) {
    process.env[RIN_WEB_SEARCH_BASE_URL_ENV] = safeString(existing.baseUrl).trim()
    return { ok: true, instanceId, baseUrl: safeString(existing.baseUrl).trim(), reused: true }
  }

  const release = await acquireFileLock(runtimeLockPathForState(stateRoot))
  let child: ReturnType<typeof spawn> | null = null
  try {
    const runtime = ensureSearxngRuntimeInstalled(stateRoot, logger)
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const settingsPath = writeSearxngSettingsForInstance(stateRoot, instanceId, baseUrl, port)
    const tmpDir = runtimeTmpDirForState(stateRoot)
    ensurePrivateDir(tmpDir)

    try { logger?.info?.(`web-search: starting searxng instance=${instanceId} baseUrl=${baseUrl}`) } catch {}
    child = spawn(runtime.pythonBin, ['-m', 'searx.webapp'], {
      cwd: runtime.sourceDir,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        TMPDIR: tmpDir,
        PYTHONUNBUFFERED: '1',
        SEARXNG_SETTINGS_PATH: settingsPath,
        SEARXNG_PORT: String(port),
        SEARXNG_BIND_ADDRESS: '127.0.0.1',
        SEARXNG_BASE_URL: `${baseUrl}/`,
        SEARXNG_LIMITER: 'false',
      },
    })
    try { child.unref() } catch {}

    writeInstanceState(stateRoot, instanceId, {
      pid: Number(child.pid || 0),
      port,
      baseUrl,
      pythonBin: runtime.pythonBin,
      sourceDir: runtime.sourceDir,
      settingsPath,
      startedAt: new Date().toISOString(),
      ownerPid: process.pid,
    })

    const deadline = Date.now() + Math.max(1, Number(options.timeoutMs || START_TIMEOUT_MS))
    while (Date.now() < deadline) {
      if (Number(child.pid || 0) > 1 && isPidAlive(child.pid)) {
        process.env[RIN_WEB_SEARCH_BASE_URL_ENV] = baseUrl
        return { ok: true, instanceId, baseUrl, pid: Number(child.pid || 0) }
      }
      await sleep(100)
    }

    throw new Error('searxng_start_timeout')
  } finally {
    try { release() } catch {}
    if (child && !(Number(child.pid || 0) > 1 && isPidAlive(child.pid))) {
      try { fs.rmSync(instanceStateFileForState(stateRoot, instanceId), { force: true }) } catch {}
    }
  }
}

async function stopSearxngSidecar(stateRoot: string, options: { logger?: any; instanceId?: string } = {}) {
  const logger = options.logger
  const instanceId = safeString(options.instanceId).trim()
  if (!instanceId) return { ok: false, error: 'web_search_instance_required' }
  const current = readInstanceState(stateRoot, instanceId) || {}
  if (Number(current.pid || 0) > 1 && isPidAlive(current.pid)) {
    try { process.kill(Number(current.pid), 'SIGTERM') } catch {}
  }
  try { fs.rmSync(instanceRootForState(stateRoot, instanceId), { recursive: true, force: true }) } catch {}
  try { logger?.info?.(`web-search: stopped searxng instance=${instanceId}`) } catch {}
  if (resolveWebSearchBaseUrl() === safeString(current.baseUrl).trim()) delete process.env[RIN_WEB_SEARCH_BASE_URL_ENV]
  return { ok: true, pid: Number(current.pid || 0) }
}

async function cleanupOrphanSearxngSidecars(stateRoot: string, options: { logger?: any } = {}) {
  const logger = options.logger
  const cleaned: Array<{ instanceId: string; pid: number; ownerPid?: number }> = []
  for (const instanceId of listInstanceIds(stateRoot)) {
    const state = readInstanceState(stateRoot, instanceId) || {}
    const ownerPid = Number(state?.ownerPid || 0)
    const pid = Number(state?.pid || 0)
    if (!(ownerPid > 1)) continue
    if (isPidAlive(ownerPid)) continue
    if (pid > 1 && isPidAlive(pid)) {
      try { process.kill(pid, 'SIGTERM') } catch {}
      await sleep(150)
    }
    try { fs.rmSync(instanceRootForState(stateRoot, instanceId), { recursive: true, force: true }) } catch {}
    cleaned.push({ instanceId, pid, ownerPid })
    try { logger?.info?.(`web-search: cleaned orphan instance=${instanceId} pid=${pid} ownerPid=${ownerPid}`) } catch {}
  }
  return { ok: true, cleaned }
}

function normalizeSearchRequest(raw: WebSearchRequest) {
  const q = safeText(raw?.q)
  const limit = Math.max(1, Math.min(8, Number(raw?.limit || 5) || 5))
  const language = safeText(raw?.language) || 'all'
  const freshness = ['day', 'week', 'month', 'year'].includes(safeText(raw?.freshness).toLowerCase())
    ? safeText(raw?.freshness).toLowerCase()
    : ''
  const domains = Array.isArray(raw?.domains)
    ? Array.from(new Set(raw.domains.map((item: any) => safeText(item)).filter(Boolean))).slice(0, 8)
    : []
  return { q, limit, language, freshness, domains }
}

function buildSearchQuery(request: ReturnType<typeof normalizeSearchRequest>) {
  const domainTerms = request.domains.map((domain) => `site:${domain}`)
  return [request.q, ...domainTerms].filter(Boolean).join(' ')
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

async function fetchJson(url: string, { method = 'GET', headers = {}, body = undefined, timeoutMs = SEARCH_TIMEOUT_MS }: any = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout:${timeoutMs}`)), Math.max(1, timeoutMs))
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal })
    const text = await res.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch {}
    if (!res.ok) throw new Error(`http_${res.status}:${safeText(text || res.statusText)}`)
    return json
  } finally {
    clearTimeout(timer)
  }
}

async function searchWeb({ q, limit, domains, freshness, language }: WebSearchRequest): Promise<WebSearchResponse> {
  const request = normalizeSearchRequest({ q, limit, domains, freshness, language })
  if (!request.q) throw new Error('web_search_query_required')
  const baseUrl = resolveWebSearchBaseUrl()
  if (!baseUrl) throw new Error('web_search_sidecar_unavailable')

  const attempts: Array<Record<string, any>> = []
  const preferredEngines = ['google', 'bing', 'duckduckgo']
  let lastError = ''

  for (const engine of preferredEngines) {
    const url = new URL('/search', `${baseUrl}/`)
    url.searchParams.set('q', buildSearchQuery(request))
    url.searchParams.set('format', 'json')
    url.searchParams.set('language', request.language)
    url.searchParams.set('safesearch', '1')
    url.searchParams.set('pageno', '1')
    url.searchParams.set('categories', 'general')
    url.searchParams.set('engines', engine)
    if (request.freshness) url.searchParams.set('time_range', request.freshness)

    try {
      const data = await fetchJson(url.toString(), {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
      })

      const rows = Array.isArray(data?.results) ? data.results : []
      const results = rows.slice(0, request.limit).map((item: any, index: number) => ({
        position: index + 1,
        title: safeText(item?.title) || '(untitled)',
        url: safeText(item?.url),
        domain: hostOf(safeText(item?.url)),
        snippet: safeText(item?.content || item?.description).slice(0, 400),
        engine: safeText(item?.engine) || engine,
        publishedDate: safeText(item?.publishedDate || item?.published_date),
      })).filter((item: any) => item.url)

      attempts.push({ engine, ok: true, results: results.length })
      if (results.length > 0) {
        return {
          ok: true,
          query: request.q,
          engine,
          attempts,
          results,
        }
      }
    } catch (error: any) {
      lastError = safeText(error?.message || error || 'web_search_failed')
      attempts.push({ engine, ok: false, error: lastError })
    }
  }

  return {
    ok: false,
    query: request.q,
    engine: preferredEngines[preferredEngines.length - 1],
    attempts,
    results: [],
    error: lastError || 'web_search_no_results',
  }
}

function getSearxngSidecarStatus(stateRoot: string) {
  const runtime = readRuntimeBootstrapState(stateRoot) || {}
  const instances = listInstanceIds(stateRoot).map((instanceId) => {
    const state = readInstanceState(stateRoot, instanceId) || {}
    const pid = Number(state?.pid || 0)
    return {
      instanceId,
      pid,
      alive: isPidAlive(pid),
      baseUrl: safeString(state?.baseUrl).trim(),
      port: Number(state?.port || 0) || undefined,
      startedAt: safeString(state?.startedAt).trim(),
      ownerPid: Number(state?.ownerPid || 0) || undefined,
      statePath: instanceStateFileForState(stateRoot, instanceId),
      settingsPath: safeString(state?.settingsPath).trim(),
    }
  })
  return {
    root: dataRootForState(stateRoot),
    runtime: {
      ready: Boolean(runtime?.ready),
      installedAt: safeString(runtime?.installedAt).trim(),
      pythonBin: safeString(runtime?.pythonBin).trim(),
      sourceDir: safeString(runtime?.sourceDir).trim(),
    },
    instances,
  }
}

export {
  RIN_WEB_SEARCH_BASE_URL_ENV,
  cleanupOrphanSearxngSidecars,
  ensureSearxngSidecar,
  getSearxngSidecarStatus,
  stopSearxngSidecar,
  searchWeb,
  type WebSearchRequest,
  type WebSearchResponse,
}
