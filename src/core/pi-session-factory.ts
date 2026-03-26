import { loadPiRpcCodingAgent } from './pi-rpc/pi-rpc-loader.js'
import { resolveRuntimeProfile } from './runtime-profile.js'

export async function createConfiguredAgentSession(
  options: {
    cwd?: string
    agentDir?: string
    additionalExtensionPaths?: string[]
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
  })
}
