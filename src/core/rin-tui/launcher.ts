import { loadRinCodingAgent } from '../rin-lib/loader.js'
import { applyRuntimeProfileEnvironment, createConfiguredAgentSession, resolveRuntimeProfile } from '../rin-lib/runtime.js'
import { ensureSearxngSidecar, stopSearxngSidecar } from '../rin-web-search/service.js'

import { RinDaemonFrontendClient } from './rpc-client.js'
import { RpcInteractiveSession } from './runtime.js'
import { applyRinTuiOverrides } from './upstream-overrides.js'

type TuiMode = 'rpc' | 'std'

function parseMode(argv: string[]): TuiMode {
  const envMode = String(process.env.RIN_TUI_MODE || '').trim().toLowerCase()
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

  await applyRinTuiOverrides()
  const codingAgentModule = await loadRinCodingAgent()
  const { InteractiveMode } = codingAgentModule as any
  const mode = parseMode(process.argv.slice(2))

  if (mode === 'std') {
    const webSearchInstanceId = `tui-${process.pid}`
    await ensureSearxngSidecar(runtime.agentDir, { instanceId: webSearchInstanceId }).catch(() => {})
    const { session } = await createConfiguredAgentSession({
      additionalExtensionPaths: options.additionalExtensionPaths,
    })
    const interactiveMode = new InteractiveMode(session, { verbose: true })
    try {
      await interactiveMode.run()
    } finally {
      await stopSearxngSidecar(runtime.agentDir, { instanceId: webSearchInstanceId }).catch(() => {})
    }
    return
  }

  const client = new RinDaemonFrontendClient()
  const session = new RpcInteractiveSession(client)
  await session.connect()

  try {
    const interactiveMode = new InteractiveMode(session as any, { verbose: true })
    await interactiveMode.run()
  } finally {
    await session.disconnect().catch(() => {})
  }
}
