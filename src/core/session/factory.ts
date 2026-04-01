import { loadRinSessionManagerModule } from '../rin-lib/loader.js'
import { createConfiguredAgentSession, getRuntimeSessionDir } from '../rin-lib/runtime.js'

export async function openBoundSession(options: {
  cwd: string
  agentDir: string
  additionalExtensionPaths?: string[]
  sessionFile?: string
}) {
  const { SessionManager } = await loadRinSessionManagerModule()
  const sessionDir = getRuntimeSessionDir(options.cwd, options.agentDir)
  const sessionManager = options.sessionFile
    ? SessionManager.open(options.sessionFile, sessionDir)
    : SessionManager.create(options.cwd, sessionDir)
  return await createConfiguredAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths ?? [],
    sessionManager,
  })
}
