#!/usr/bin/env node
/**
 * App worker entrypoint.
 *
 * This file exists so app can inject builtin extension paths while keeping
 * the core worker independently runnable and free of app-specific profiles.
 */
import { startWorker } from '../../core/pi-rpc-daemon/worker.js'
import { getBuiltinExtensionPaths } from '../builtin-extensions.js'

async function main() {
  await startWorker({ additionalExtensionPaths: getBuiltinExtensionPaths() })
}

main().catch((error: any) => {
  console.error(String(error?.message || error || 'pi_rpc_app_worker_failed'))
  process.exit(1)
})
