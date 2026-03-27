#!/usr/bin/env node
import { startKoishi } from '../../core/rin-koishi/main.js'
import { getBuiltinExtensionPaths } from '../builtin-extensions.js'

async function main() {
  await startKoishi({ additionalExtensionPaths: getBuiltinExtensionPaths() })
}

main().catch((error: any) => {
  console.error(String(error?.message || error || 'rin_app_koishi_failed'))
  process.exit(1)
})
