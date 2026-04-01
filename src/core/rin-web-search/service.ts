// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'

import { ensureDir, ensurePrivateDir } from '../platform/fs.js'
import { acquireProcessLock } from '../sidecar/common.js'
import { isPidAlive, safeString, sleep } from '../platform/process.js'
import { dataRootForState, instanceRootForState, instanceSettingsFileForState, instanceStateFileForState, listInstanceIds, readInstanceState, readRuntimeBootstrapState, removeInstanceState, runtimeLockPathForState, runtimePipBinForState, runtimePythonBinForState, runtimeRootForState, runtimeSourceDirForState, runtimeTmpDirForState, runtimeVenvDirForState, writeInstanceState, writeRuntimeBootstrapState } from './paths.js'
import { searchWeb as performWebSearch, safeText, type WebSearchRequest, type WebSearchResponse } from './query.js'

const START_TIMEOUT_MS = 90_000
const RIN_WEB_SEARCH_BASE_URL_ENV = 'RIN_WEB_SEARCH_BASE_URL'

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

  const release = await acquireProcessLock(runtimeLockPathForState(stateRoot)).catch((error: any) => {
    throw new Error(String(error?.message || error || `web_search_lock_timeout:${runtimeLockPathForState(stateRoot)}`))
  })
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
      removeInstanceState(stateRoot, instanceId)
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

async function searchWeb({ q, limit, domains, freshness, language }: WebSearchRequest): Promise<WebSearchResponse> {
  return await performWebSearch(resolveWebSearchBaseUrl(), { q, limit, domains, freshness, language })
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
