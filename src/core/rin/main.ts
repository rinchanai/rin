#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function safeString(value: unknown) {
  if (value == null) return ''
  return String(value)
}

function repoRootFromHere() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

function readPasswdUser(name: string) {
  if (process.platform === 'darwin') {
    try {
      const detail = execFileSync('dscl', ['.', '-read', `/Users/${name}`, 'NFSHomeDirectory', 'UserShell'], { encoding: 'utf8' })
      let home = ''
      let shell = ''
      for (const line of detail.split(/\r?\n/)) {
        if (line.startsWith('NFSHomeDirectory:')) home = line.replace(/^NFSHomeDirectory:\s*/, '').trim()
        if (line.startsWith('UserShell:')) shell = line.replace(/^UserShell:\s*/, '').trim()
      }
      return { name, home, shell }
    } catch {}
    return null
  }

  try {
    const raw = fs.readFileSync('/etc/passwd', 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const [user = '', , , , , home = '', shell = ''] = line.split(':')
      if (user !== name) continue
      return { name: user, home, shell }
    }
  } catch {}
  return null
}

function runCommand(command: string, args: string[], options: any = {}) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`terminated:${signal}`))
      resolve(code ?? 0)
    })
  })
}

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function buildUserShell(targetUser: string, argv: string[], env: Record<string, string> = {}) {
  const currentUser = os.userInfo().username
  if (!targetUser || targetUser === currentUser) {
    return {
      command: argv[0],
      args: argv.slice(1),
      env: { ...process.env, ...env },
    }
  }

  const target = readPasswdUser(targetUser)
  if (!target) throw new Error(`target_user_not_found:${targetUser}`)

  const shellCommand = [
    ...Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    ...argv.map((arg) => shellQuote(arg)),
  ].join(' ')

  if (process.platform !== 'win32' && fs.existsSync('/usr/sbin/runuser')) {
    return {
      command: '/usr/sbin/runuser',
      args: ['-u', targetUser, '--', 'sh', '-lc', shellCommand],
      env: { ...process.env, HOME: target.home || `${process.platform === 'darwin' ? '/Users' : '/home'}/${targetUser}` },
    }
  }

  return {
    command: 'sudo',
    args: ['-u', targetUser, 'sh', '-lc', shellCommand],
    env: { ...process.env, HOME: target.home || `${process.platform === 'darwin' ? '/Users' : '/home'}/${targetUser}` },
  }
}

function installConfigPath() {
  return path.join(os.homedir(), '.config', 'rin', 'install.json')
}

function loadInstallConfig() {
  const filePath = installConfigPath()
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as { defaultTargetUser?: string; defaultInstallDir?: string }
  } catch {
    return {}
  }
}

function usage() {
  console.log([
    'Usage: rin [--user <name>|-u <name>] [--std] [--tmux <session>|-t <session>] [--tmux-list]',
    '',
    'Defaults to the RPC TUI for the target user.',
    'Options:',
    '  --user, -u <name>    Run against a specific daemon user',
    '  --std                Start std TUI instead of RPC TUI',
    '  --tmux, -t <name>    Create or attach a hidden Rin tmux session',
    '  --tmux-list          List hidden Rin tmux sessions',
  ].join('\n'))
}

function parseArgs(argv: string[]) {
  const installConfig = loadInstallConfig()
  let targetUser = ''
  let std = false
  let tmuxSession = ''
  let tmuxList = false
  let explicitUser = false
  const passthrough: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--user' || arg === '-u') {
      targetUser = safeString(argv[i + 1]).trim()
      explicitUser = true
      i += 1
      continue
    }
    if (arg === '--std') {
      std = true
      continue
    }
    if (arg === '--tmux' || arg === '-t') {
      tmuxSession = safeString(argv[i + 1]).trim()
      i += 1
      continue
    }
    if (arg === '--tmux-list') {
      tmuxList = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      usage()
      process.exit(0)
    }
    passthrough.push(arg)
  }

  return {
    targetUser: targetUser || safeString(installConfig.defaultTargetUser).trim() || os.userInfo().username,
    installDir: safeString(installConfig.defaultInstallDir).trim(),
    std,
    tmuxSession,
    tmuxList,
    passthrough,
    explicitUser,
    hasSavedInstall: Boolean(safeString(installConfig.defaultTargetUser).trim() || safeString(installConfig.defaultInstallDir).trim()),
  }
}

export async function startRinCli() {
  const parsed = parseArgs(process.argv.slice(2))
  const repoRoot = repoRootFromHere()
  const targetUser = parsed.targetUser
  const tmuxSocketName = `rin-${targetUser}`

  if (!parsed.explicitUser && !parsed.hasSavedInstall) {
    throw new Error(`rin_not_installed: run rin-install first or pass --user/-u explicitly (expected ${installConfigPath()})`)
  }

  if (parsed.tmuxSession && parsed.tmuxList) throw new Error('rin_tmux_mode_conflict')

  const runtimeEnv = parsed.installDir ? { RIN_DIR: parsed.installDir } : {}

  if (parsed.tmuxList) {
    const launch = buildUserShell(targetUser, ['tmux', '-L', tmuxSocketName, 'list-sessions'], runtimeEnv)
    const code = await runCommand(launch.command, launch.args, { env: launch.env, cwd: repoRoot })
    process.exit(code)
  }

  if (parsed.tmuxSession) {
    const innerArgs = [process.execPath, path.join(repoRoot, 'dist', 'app', 'rin-tui', 'main.js'), parsed.std ? '--std' : '--rpc', ...parsed.passthrough]
    const innerLaunch = buildUserShell(targetUser, innerArgs, runtimeEnv)
    const code = await runCommand('tmux', ['-L', tmuxSocketName, 'new-session', '-A', '-s', parsed.tmuxSession, innerLaunch.command, ...innerLaunch.args], {
      env: innerLaunch.env,
      cwd: repoRoot,
    })
    process.exit(code)
  }

  const launch = buildUserShell(targetUser, [process.execPath, path.join(repoRoot, 'dist', 'app', 'rin-tui', 'main.js'), parsed.std ? '--std' : '--rpc', ...parsed.passthrough], runtimeEnv)
  const code = await runCommand(launch.command, launch.args, { env: launch.env, cwd: repoRoot })
  process.exit(code)
}

