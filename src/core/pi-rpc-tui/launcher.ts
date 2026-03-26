import { loadPiRpcCodingAgent } from '../pi-rpc/pi-rpc-loader.js'
import { createConfiguredAgentSession } from '../pi-session-factory.js'
import { applyRuntimeProfileEnvironment, resolveRuntimeProfile } from '../runtime-profile.js'

import { PiRpcDaemonFrontendClient } from './rpc-client.js'
import { RpcInteractiveSession } from './runtime.js'

type TuiMode = 'rpc' | 'std'

function parseMode(argv: string[]): TuiMode {
  const envMode = String(process.env.PI_RPC_TUI_MODE || '').trim().toLowerCase()
  if (envMode === 'std') return 'std'
  if (envMode === 'rpc') return 'rpc'
  if (argv.includes('--std')) return 'std'
  if (argv.includes('--rpc')) return 'rpc'
  return 'rpc'
}

export async function startTui(options: { additionalExtensionPaths?: string[] } = {}) {
  const runtime = resolveRuntimeProfile()
  applyRuntimeProfileEnvironment(runtime)
  if (process.cwd() !== runtime.cwd) {
    process.chdir(runtime.cwd)
  }

  const codingAgentModule = await loadPiRpcCodingAgent()
  const { InteractiveMode } = codingAgentModule as any
  const mode = parseMode(process.argv.slice(2))

  if (mode === 'std') {
    const { session } = await createConfiguredAgentSession({
      additionalExtensionPaths: options.additionalExtensionPaths,
    })
    const interactiveMode = new InteractiveMode(session, { verbose: true })
    await interactiveMode.run()
    return
  }

  const client = new PiRpcDaemonFrontendClient()
  const session = new RpcInteractiveSession(client)
  await session.connect()

  try {
    const interactiveMode = new InteractiveMode(session as any, { verbose: true })
    await interactiveMode.run()
  } finally {
    await session.disconnect().catch(() => {})
  }
}
