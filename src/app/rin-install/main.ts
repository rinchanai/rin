#!/usr/bin/env node
import { startInstaller } from '../../core/rin-install/main.js'

startInstaller().catch((error: any) => {
  console.error(String(error?.message || error || 'rin_app_install_failed'))
  process.exit(1)
})
