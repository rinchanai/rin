#!/usr/bin/env node
import { startRinCli } from '../../core/rin/main.js'

startRinCli().catch((error: any) => {
  console.error(String(error?.message || error || 'rin_app_cli_failed'))
  process.exit(1)
})
