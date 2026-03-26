#!/usr/bin/env node
/**
 * App daemon entrypoint.
 *
 * This is intentionally only an assembly wrapper:
 * it reuses the core daemon implementation, but points it at the app worker,
 * so builtin extensions are force-loaded without teaching core about app policy.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startDaemon } from '../../core/pi-rpc-daemon/daemon.js'

async function main() {
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js')
  await startDaemon({ workerPath })
}

main().catch((error: any) => {
  console.error(String(error?.message || error || 'pi_rpc_app_daemon_failed'))
  process.exit(1)
})
