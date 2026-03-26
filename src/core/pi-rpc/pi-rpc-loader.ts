import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import jiti from '@mariozechner/jiti'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const codingAgentRoot = path.join(repoRoot, 'third_party', 'pi-coding-agent')
const codingAgentDistRoot = path.join(codingAgentRoot, 'dist')
const codingAgentSrcRoot = path.join(codingAgentRoot, 'src')

const sourceLoader = jiti(import.meta.url, {
  interopDefault: true,
  moduleCache: true,
})

function hasDistModule(relativePath: string) {
  return fs.existsSync(path.join(codingAgentDistRoot, relativePath))
}

async function importDistModule(relativePath: string) {
  return await import(pathToFileURL(path.join(codingAgentDistRoot, relativePath)).href)
}

async function importSourceModule(relativePath: string) {
  return await sourceLoader.import(path.join(codingAgentSrcRoot, relativePath))
}

export async function loadPiRpcCodingAgent() {
  if (hasDistModule('index.js')) return await importDistModule('index.js')
  return await importSourceModule('index.ts')
}

export async function loadPiRpcSessionManagerModule() {
  if (hasDistModule(path.join('core', 'session-manager.js'))) {
    return await importDistModule(path.join('core', 'session-manager.js'))
  }
  return await importSourceModule(path.join('core', 'session-manager.ts'))
}

export function resolvePiRpcCodingAgentDistDir() {
  return codingAgentDistRoot
}
