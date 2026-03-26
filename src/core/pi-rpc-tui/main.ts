#!/usr/bin/env node
import { loadPiRpcCodingAgent } from '../pi-rpc/pi-rpc-loader.js'

import { PiRpcDaemonFrontendClient } from './rpc-client.js'
import { RpcInteractiveSession } from './runtime.js'

async function main() {
  const interactiveModule = await loadPiRpcCodingAgent()
  const { InteractiveMode } = interactiveModule as any

  const client = new PiRpcDaemonFrontendClient()
  const session = new RpcInteractiveSession(client)
  await session.connect()

  const mode = new InteractiveMode(session as any, {
    verbose: true,
  })

  await mode.run()
}

main().catch((error: any) => {
  console.error(String(error?.message || error || 'pi_rpc_tui_failed'))
  process.exit(1)
})
