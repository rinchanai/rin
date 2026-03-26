#!/usr/bin/env node
/**
 * App TUI entrypoint.
 *
 * Thin assembly wrapper over the shared core TUI launcher.
 * The only app-specific behavior here is force-loading builtin extensions.
 */
import { startTui } from '../../core/pi-rpc-tui/launcher.js'
import { getBuiltinExtensionPaths } from '../builtin-extensions.js'

startTui({ additionalExtensionPaths: getBuiltinExtensionPaths() }).catch((error: any) => {
  console.error(String(error?.message || error || 'pi_rpc_app_tui_failed'))
  process.exit(1)
})
