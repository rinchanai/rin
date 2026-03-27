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

import { startDaemon } from '../../core/rin-daemon/daemon.js'
import { resolveRuntimeProfile } from '../../core/rin-lib/runtime.js'
import { ensureSearxngSidecar, stopSearxngSidecar } from '../../core/rin-web-search/service.js'

async function main() {
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js')
  const runtime = resolveRuntimeProfile()
  const webSearchInstanceId = `daemon-${process.pid}`
  await ensureSearxngSidecar(runtime.agentDir, { instanceId: webSearchInstanceId }).catch(() => {})
  const stop = () => { void stopSearxngSidecar(runtime.agentDir, { instanceId: webSearchInstanceId }).catch(() => {}) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('exit', stop)
  await startDaemon({ workerPath })
}

main().catch((error: any) => {
  console.error(String(error?.message || error || 'rin_app_daemon_failed'))
  process.exit(1)
})
