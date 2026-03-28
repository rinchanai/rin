#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { defaultDaemonSocketPath } from '../rin-lib/common.js'
import { PI_AGENT_DIR_ENV, RIN_DIR_ENV } from '../rin-lib/runtime.js'

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

function pickPrivilegeCommand() {
  if (process.platform !== 'win32' && fs.existsSync('/usr/sbin/runuser')) return '/usr/sbin/runuser'
  if (process.platform !== 'win32' && fs.existsSync('/run/current-system/sw/bin/doas')) return '/run/current-system/sw/bin/doas'
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/doas')) return '/usr/bin/doas'
  if (process.platform !== 'win32' && fs.existsSync('/bin/doas')) return '/bin/doas'
  return 'sudo'
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

  const privilegeCommand = pickPrivilegeCommand()
  if (privilegeCommand.endsWith('runuser')) {
    return {
      command: privilegeCommand,
      args: ['-u', targetUser, '--', 'sh', '-lc', shellCommand],
      env: { ...process.env, HOME: target.home || `${process.platform === 'darwin' ? '/Users' : '/home'}/${targetUser}` },
    }
  }

  if (privilegeCommand.endsWith('doas')) {
    return {
      command: privilegeCommand,
      args: ['-u', targetUser, 'sh', '-lc', shellCommand],
      env: { ...process.env, HOME: target.home || `${process.platform === 'darwin' ? '/Users' : '/home'}/${targetUser}` },
    }
  }

  return {
    command: privilegeCommand,
    args: ['-u', targetUser, 'sh', '-lc', shellCommand],
    env: { ...process.env, HOME: target.home || `${process.platform === 'darwin' ? '/Users' : '/home'}/${targetUser}` },
  }
}

function appConfigDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'rin')
  return path.join(os.homedir(), '.config', 'rin')
}

function installConfigPath() {
  return path.join(appConfigDir(), 'install.json')
}

function loadInstallConfig() {
  const filePath = installConfigPath()
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as { defaultTargetUser?: string; defaultInstallDir?: string }
  } catch {
    return {}
  }
}

async function canConnectSocket(socketPath: string) {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath)
    let done = false
    const finish = (value: boolean) => {
      if (done) return
      done = true
      try { socket.destroy() } catch {}
      resolve(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    setTimeout(() => finish(false), 500)
  })
}

async function ensureDaemonAvailable(repoRoot: string, targetUser: string, env: Record<string, string>) {
  const socketPath = defaultDaemonSocketPath()
  if (await canConnectSocket(socketPath)) return
  const daemonEntry = path.join(repoRoot, 'dist', 'app', 'rin-daemon', 'daemon.js')
  const launch = buildUserShell(targetUser, [process.execPath, daemonEntry], env)
  const child = spawn(launch.command, launch.args, {
    cwd: repoRoot,
    env: launch.env,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    if (await canConnectSocket(socketPath)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  throw new Error(`rin_daemon_unavailable: failed to start daemon for ${targetUser}`)
}

function requireTool(name: string, paths: string[] = []) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  try {
    return execFileSync('sh', ['-lc', `command -v ${shellQuote(name)}`], { encoding: 'utf8' }).trim() || name
  } catch {
    throw new Error(`rin_missing_required_tool:${name}`)
  }
}

function runCommandSync(command: string, args: string[], options: any = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options })
}

function writeExecutable(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o755 })
  fs.chmodSync(filePath, 0o755)
}

function syncTree(sourcePath: string, destPath: string) {
  runCommandSync('rm', ['-rf', destPath])
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  runCommandSync('cp', ['-a', sourcePath, destPath])
}

function releaseIdNow() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
}

function writeUserLaunchers(installDir: string) {
  const binDir = path.join(os.homedir(), '.local', 'bin')
  const rinTarget = path.join(installDir, 'app', 'current', 'dist', 'app', 'rin', 'main.js')
  const rinInstallTarget = path.join(installDir, 'app', 'current', 'dist', 'app', 'rin-install', 'main.js')
  writeExecutable(path.join(binDir, 'rin'), `#!/usr/bin/env sh\nexec ${shellQuote(process.execPath)} ${shellQuote(rinTarget)} "$@"\n`)
  writeExecutable(path.join(binDir, 'rin-install'), `#!/usr/bin/env sh\nexec ${shellQuote(process.execPath)} ${shellQuote(rinInstallTarget)} "$@"\n`)
}

function resolveInstallDirForTarget(parsed: ReturnType<typeof parseArgs>) {
  const target = readPasswdUser(parsed.targetUser)
  return parsed.installDir || path.join(target?.home || os.homedir(), '.rin')
}

async function runRestart(parsed: ReturnType<typeof parseArgs>) {
  const repoRoot = repoRootFromHere()
  const installDir = resolveInstallDirForTarget(parsed)
  const runtimeEnv = { [RIN_DIR_ENV]: installDir, [PI_AGENT_DIR_ENV]: installDir }
  const targetUser = parsed.targetUser
  const systemctl = process.platform === 'linux'
    ? (fs.existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : (fs.existsSync('/bin/systemctl') ? '/bin/systemctl' : ''))
    : ''

  if (systemctl) {
    for (const unit of [`rin-daemon-${targetUser}.service`, 'rin-daemon.service']) {
      try {
        const check = buildUserShell(targetUser, [systemctl, '--user', 'status', unit], runtimeEnv)
        execFileSync(check.command, check.args, { stdio: 'ignore', env: check.env, cwd: repoRoot })
        const restart = buildUserShell(targetUser, [systemctl, '--user', 'restart', unit], runtimeEnv)
        execFileSync(restart.command, restart.args, { stdio: 'inherit', env: restart.env, cwd: repoRoot })
        console.log(`rin restart complete: ${unit}`)
        return
      } catch {}
    }
  }

  try {
    const pkill = requireTool('pkill', ['/usr/bin/pkill', '/bin/pkill'])
    const daemonPattern = `${installDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/app/.*/dist/(app/rin-daemon/daemon\\.js|daemon\\.js)`
    const stop = buildUserShell(targetUser, [pkill, '-f', daemonPattern], runtimeEnv)
    execFileSync(stop.command, stop.args, { stdio: 'ignore', env: stop.env, cwd: repoRoot })
  } catch {}

  await ensureDaemonAvailable(repoRoot, targetUser, runtimeEnv)
  console.log('rin restart complete')
}

async function runUpdate(parsed: ReturnType<typeof parseArgs>) {
  const installDir = resolveInstallDirForTarget(parsed)

  const curl = process.platform === 'win32' ? '' : (fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : '')
  const wget = process.platform === 'win32' ? '' : (fs.existsSync('/usr/bin/wget') ? '/usr/bin/wget' : '')
  const tar = requireTool('tar', ['/usr/bin/tar', '/bin/tar'])
  const npm = requireTool('npm', ['/usr/bin/npm', '/bin/npm'])
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-update-'))
  const archivePath = path.join(tempRoot, 'rin.tar.gz')
  const sourceRoot = path.join(tempRoot, 'src')
  const releaseRoot = path.join(installDir, 'app', 'releases', releaseIdNow())
  const currentLink = path.join(installDir, 'app', 'current')
  const currentTmpLink = `${currentLink}.tmp`

  try {
    fs.mkdirSync(sourceRoot, { recursive: true })
    if (curl) {
      runCommandSync(curl, ['-fsSL', 'https://github.com/THE-cattail/rin/archive/refs/heads/main.tar.gz', '-o', archivePath])
    } else if (wget) {
      runCommandSync(wget, ['-qO', archivePath, 'https://github.com/THE-cattail/rin/archive/refs/heads/main.tar.gz'])
    } else {
      throw new Error('rin_missing_required_tool:curl_or_wget')
    }
    runCommandSync(tar, ['-xzf', archivePath, '-C', sourceRoot, '--strip-components=1'])

    if (fs.existsSync(path.join(sourceRoot, 'package-lock.json'))) {
      runCommandSync(npm, ['ci', '--no-fund', '--no-audit'], { cwd: sourceRoot })
    } else {
      runCommandSync(npm, ['install', '--no-fund', '--no-audit'], { cwd: sourceRoot })
    }
    runCommandSync(npm, ['run', 'build'], { cwd: sourceRoot })

    fs.mkdirSync(releaseRoot, { recursive: true })
    for (const name of ['dist', 'node_modules', 'third_party', 'extensions', 'package.json']) {
      syncTree(path.join(sourceRoot, name), path.join(releaseRoot, name))
    }

    try { fs.rmSync(currentTmpLink, { recursive: true, force: true }) } catch {}
    fs.symlinkSync(releaseRoot, currentTmpLink)
    try { fs.rmSync(currentLink, { recursive: true, force: true }) } catch {}
    fs.renameSync(currentTmpLink, currentLink)

    writeUserLaunchers(installDir)
    console.log(`rin update complete: ${releaseRoot}`)
  } finally {
    try { fs.rmSync(currentTmpLink, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
  }
}

function usage() {
  console.log([
    'Usage: rin [update|upgrade|restart] [--user <name>|-u <name>] [--std] [--tmux <session>|-t <session>] [--tmux-list]',
    '',
    'Defaults to the RPC TUI for the target user.',
    'Commands:',
    '  update, upgrade      Upgrade the installed Rin runtime from GitHub main',
    '  restart              Restart the target user daemon',
    '',
    'Options:',
    '  --user, -u <name>    Run against a specific daemon user',
    '  --std                Start std TUI instead of RPC TUI',
    '  --tmux, -t <name>    Create or attach a hidden Rin tmux session',
    '  --tmux-list          List hidden Rin tmux sessions',
  ].join('\n'))
}

function parseArgs(argv: string[]) {
  const installConfig = loadInstallConfig()
  let command = ''
  let targetUser = ''
  let std = false
  let tmuxSession = ''
  let tmuxList = false
  let explicitUser = false
  const passthrough: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!command && (arg === 'update' || arg === 'upgrade')) {
      command = 'update'
      continue
    }
    if (!command && arg === 'restart') {
      command = 'restart'
      continue
    }
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
    command,
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
  if (parsed.command === 'update') {
    await runUpdate(parsed)
    return
  }
  if (parsed.command === 'restart') {
    await runRestart(parsed)
    return
  }

  const repoRoot = repoRootFromHere()
  const targetUser = parsed.targetUser
  const tmuxSocketName = `rin-${targetUser}`

  if (!parsed.explicitUser && !parsed.hasSavedInstall) {
    throw new Error(`rin_not_installed: run rin-install first or pass --user/-u explicitly (expected ${installConfigPath()})`)
  }

  if (parsed.tmuxSession && parsed.tmuxList) throw new Error('rin_tmux_mode_conflict')

  const runtimeEnv = parsed.installDir
    ? { [RIN_DIR_ENV]: parsed.installDir, [PI_AGENT_DIR_ENV]: parsed.installDir }
    : {}

  if (parsed.tmuxList) {
    const launch = buildUserShell(targetUser, ['tmux', '-L', tmuxSocketName, 'list-sessions'], runtimeEnv)
    const code = await runCommand(launch.command, launch.args, { env: launch.env, cwd: repoRoot })
    process.exit(code)
  }

  if (!parsed.std) {
    await ensureDaemonAvailable(repoRoot, targetUser, runtimeEnv)
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

