import os from 'node:os'
import path from 'node:path'

import { loadPiRpcCodingAgent } from './loader.js'

export const RIN_DIR_ENV = 'RIN_DIR'
export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR'

export function resolveRuntimeProfile(options: { cwd?: string; agentDir?: string } = {}) {
  const cwd = options.cwd || os.homedir()
  const agentDir = options.agentDir || process.env[RIN_DIR_ENV]?.trim() || path.join(os.homedir(), '.rin')
  return { cwd, agentDir }
}

export function applyRuntimeProfileEnvironment(profile: { agentDir: string }) {
  if (profile.agentDir) {
    process.env[PI_AGENT_DIR_ENV] = profile.agentDir
  }
}

export function getRuntimeSessionDir(cwd: string, agentDir: string) {
  const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return path.join(agentDir, 'sessions', safePath)
}

export async function createConfiguredAgentSession(
  options: {
    cwd?: string
    agentDir?: string
    additionalExtensionPaths?: string[]
    sessionManager?: any
  } = {},
) {
  const codingAgentModule = await loadPiRpcCodingAgent()
  const {
    createAgentSession,
    DefaultResourceLoader,
    SettingsManager,
  } = codingAgentModule as any

  const { cwd, agentDir } = resolveRuntimeProfile({
    cwd: options.cwd,
    agentDir: options.agentDir,
  })

  applyRuntimeProfileEnvironment({ agentDir })

  if (process.cwd() !== cwd) {
    process.chdir(cwd)
  }

  const settingsManager = SettingsManager.create(cwd, agentDir)
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: options.additionalExtensionPaths ?? [],
  })
  await resourceLoader.reload()

  return await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: options.sessionManager,
  })
}
