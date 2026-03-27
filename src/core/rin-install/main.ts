#!/usr/bin/env node
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

function printBanner() {
  output.write('\x1bc')
  output.write('Rin Installer\n')
  output.write('============\n\n')
}

export async function startInstaller() {
  printBanner()
  output.write('Source: GitHub main\n')
  output.write('Mode: placeholder installer\n\n')
  output.write('This installer TUI is intentionally empty for now.\n')
  output.write('It does not install or modify anything yet.\n\n')

  const rl = readline.createInterface({ input, output })
  try {
    await rl.question('Press Enter to exit... ')
  } finally {
    rl.close()
  }
}

async function main() {
  await startInstaller()
}

main().catch((error: any) => {
  console.error(String(error?.message || error || 'rin_install_failed'))
  process.exit(1)
})
