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
  if (process.platform !== 'win32' && fs.existsSync('/run/current-system/sw/bin/doas')) return '/run/current-system/sw/bin/doas'
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/doas')) return '/usr/bin/doas'
  if (process.platform !== 'win32' && fs.existsSync('/bin/doas')) return '/bin/doas'
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/sudo')) return '/usr/bin/sudo'
  if (process.platform !== 'win32' && fs.existsSync('/bin/sudo')) return '/bin/sudo'
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

  const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false
  if (isRoot && process.platform !== 'win32' && fs.existsSync('/usr/sbin/runuser')) {
    return {
      command: '/usr/sbin/runuser',
      args: ['-u', targetUser, '--', 'sh', '-lc', shellCommand],
      env: { ...process.env, HOME: target.home || `${process.platform === 'darwin' ? '/Users' : '/home'}/${targetUser}` },
    }
  }

  const privilegeCommand = pickPrivilegeCommand()
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

function homeForUser(targetUser: string) {
  const target = readPasswdUser(targetUser)
  return target?.home || path.join(process.platform === 'darwin' ? '/Users' : '/home', targetUser)
}

function appConfigDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'rin')
  return path.join(os.homedir(), '.config', 'rin')
}

function socketPathForUser(targetUser: string) {
  const currentUser = os.userInfo().username
  if (!targetUser || targetUser === currentUser) return defaultDaemonSocketPath()
  if (process.platform === 'darwin') return path.join(homeForUser(targetUser), 'Library', 'Caches', 'rin-daemon', 'daemon.sock')
  const uid = Number(execFileSync('id', ['-u', targetUser], { encoding: 'utf8' }).trim() || '-1')
  if (uid >= 0) return path.join('/run/user', String(uid), 'rin-daemon', 'daemon.sock')
  return defaultDaemonSocketPath()
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

function canConnectSocketAsTargetUser(targetUser: string, socketPath: string) {
  const currentUser = os.userInfo().username
  if (!targetUser || targetUser === currentUser) return canConnectSocket(socketPath)
  try {
    const launch = buildUserShell(targetUser, [
      process.execPath,
      '-e',
      `const net=require('node:net');const s=net.createConnection(${JSON.stringify(socketPath)});let done=false;const finish=(ok)=>{if(done)return;done=true;try{s.destroy()}catch{};process.exit(ok?0:1)};s.once('connect',()=>finish(true));s.once('error',()=>finish(false));setTimeout(()=>finish(false),500);`,
    ])
    execFileSync(launch.command, launch.args, { stdio: 'ignore', env: launch.env, cwd: repoRootFromHere() })
    return Promise.resolve(true)
  } catch {
    return Promise.resolve(false)
  }
}

function targetUserRuntimeEnv(targetUser: string, env: Record<string, string> = {}) {
  const target = readPasswdUser(targetUser)
  const uid = typeof process.platform === 'string' && process.platform !== 'darwin' && target?.name
    ? Number(execFileSync('id', ['-u', targetUser], { encoding: 'utf8' }).trim() || '-1')
    : -1
  const runtimeDir = uid >= 0 ? `/run/user/${uid}` : ''
  const busPath = runtimeDir ? path.join(runtimeDir, 'bus') : ''
  return {
    ...env,
    ...(runtimeDir && fs.existsSync(runtimeDir) ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
    ...(busPath && fs.existsSync(busPath) ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}` } : {}),
  }
}

async function ensureDaemonAvailable(repoRoot: string, targetUser: string, env: Record<string, string>) {
  const socketPath = socketPathForUser(targetUser)
  if (await canConnectSocketAsTargetUser(targetUser, socketPath)) return

  const currentUser = os.userInfo().username
  const systemctl = process.platform === 'linux'
    ? (fs.existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : (fs.existsSync('/bin/systemctl') ? '/bin/systemctl' : ''))
    : ''
  const userEnv = targetUserRuntimeEnv(targetUser, env)

  if (targetUser !== currentUser && systemctl) {
    for (const unit of [`rin-daemon-${targetUser}.service`, 'rin-daemon.service']) {
      try {
        const start = buildUserShell(targetUser, [systemctl, '--user', 'start', unit], userEnv)
        execFileSync(start.command, start.args, { stdio: 'inherit', env: start.env, cwd: repoRoot })
        break
      } catch {}
    }
    const startedAt = Date.now()
    while (Date.now() - startedAt < 5000) {
      if (await canConnectSocketAsTargetUser(targetUser, socketPath)) return
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  const daemonEntry = path.join(repoRoot, 'dist', 'app', 'rin-daemon', 'daemon.js')
  const launch = buildUserShell(targetUser, [process.execPath, daemonEntry], userEnv)
  const child = spawn(launch.command, launch.args, {
    cwd: repoRoot,
    env: launch.env,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    if (await canConnectSocketAsTargetUser(targetUser, socketPath)) return
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

function launcherScript(candidates: string[]) {
  const checks = candidates.map((candidate) => `if [ -f ${shellQuote(candidate)} ]; then exec ${shellQuote(process.execPath)} ${shellQuote(candidate)} "$@"; fi`).join('\n')
  return `#!/usr/bin/env sh
${checks}
echo "rin: installed runtime entry not found" >&2
exit 1
`
}

function writeUserLaunchers(installDir: string) {
  const binDir = path.join(os.homedir(), '.local', 'bin')
  const rinCandidates = [
    path.join(installDir, 'app', 'current', 'dist', 'app', 'rin', 'main.js'),
    path.join(installDir, 'app', 'current', 'dist', 'index.js'),
  ]
  const rinInstallCandidates = [
    path.join(installDir, 'app', 'current', 'dist', 'app', 'rin-install', 'main.js'),
  ]
  writeExecutable(path.join(binDir, 'rin'), launcherScript(rinCandidates))
  writeExecutable(path.join(binDir, 'rin-install'), launcherScript(rinInstallCandidates))
}

function daemonEntryForInstallDir(installDir: string) {
  const currentStyle = path.join(installDir, 'app', 'current', 'dist', 'app', 'rin-daemon', 'daemon.js')
  if (fs.existsSync(currentStyle)) return currentStyle
  return path.join(installDir, 'app', 'current', 'dist', 'daemon.js')
}

function buildSystemdServiceText(targetUser: string, targetHome: string, installDir: string, description: string) {
  return `[Unit]\nDescription=${description}\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${targetHome}\nEnvironment=${RIN_DIR_ENV}=${installDir}\nEnvironment=${PI_AGENT_DIR_ENV}=${installDir}\nExecStart=${process.execPath} ${daemonEntryForInstallDir(installDir)}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`
}

function refreshManagedServiceFiles(targetUser: string, installDir: string) {
  if (process.platform !== 'linux') return
  const target = readPasswdUser(targetUser)
  if (!target?.home) return
  const userUnitDir = path.join(target.home, '.config', 'systemd', 'user')
  if (!fs.existsSync(userUnitDir)) return

  const candidateFiles = [
    {
      path: path.join(userUnitDir, `rin-daemon-${String(targetUser).replace(/[^A-Za-z0-9_.@-]+/g, '-')}.service`),
      description: `Rin daemon for ${targetUser}`,
    },
    {
      path: path.join(userUnitDir, 'rin-daemon.service'),
      description: 'Rin daemon',
    },
  ]

  for (const entry of candidateFiles) {
    if (!fs.existsSync(entry.path)) continue
    fs.mkdirSync(path.dirname(entry.path), { recursive: true })
    fs.writeFileSync(entry.path, buildSystemdServiceText(targetUser, target.home, installDir, entry.description), { encoding: 'utf8', mode: 0o644 })
    fs.chmodSync(entry.path, 0o644)
  }
}

function resolveInstallDirForTarget(parsed: ReturnType<typeof parseArgs>) {
  const target = readPasswdUser(parsed.targetUser)
  return parsed.installDir || path.join(target?.home || os.homedir(), '.rin')
}

function daemonControlContext(parsed: ReturnType<typeof parseArgs>) {
  const repoRoot = repoRootFromHere()
  const installDir = resolveInstallDirForTarget(parsed)
  const targetUser = parsed.targetUser
  const runtimeEnv = targetUserRuntimeEnv(targetUser, { [RIN_DIR_ENV]: installDir, [PI_AGENT_DIR_ENV]: installDir })
  const systemctl = process.platform === 'linux'
    ? (fs.existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : (fs.existsSync('/bin/systemctl') ? '/bin/systemctl' : ''))
    : ''
  const socketPath = socketPathForUser(targetUser)
  return { repoRoot, installDir, targetUser, runtimeEnv, systemctl, socketPath }
}

function tryManagedServiceAction(context: ReturnType<typeof daemonControlContext>, action: 'start' | 'stop' | 'restart') {
  if (!context.systemctl) return false
  try {
    const reload = buildUserShell(context.targetUser, [context.systemctl, '--user', 'daemon-reload'], context.runtimeEnv)
    execFileSync(reload.command, reload.args, { stdio: 'ignore', env: reload.env, cwd: context.repoRoot })
  } catch {}
  for (const unit of [`rin-daemon-${context.targetUser}.service`, 'rin-daemon.service']) {
    try {
      const check = buildUserShell(context.targetUser, [context.systemctl, '--user', 'status', unit], context.runtimeEnv)
      execFileSync(check.command, check.args, { stdio: 'ignore', env: check.env, cwd: context.repoRoot })
      const effectiveAction = action === 'start' ? 'restart' : action
      const run = buildUserShell(context.targetUser, [context.systemctl, '--user', effectiveAction, unit], context.runtimeEnv)
      execFileSync(run.command, run.args, { stdio: 'inherit', env: run.env, cwd: context.repoRoot })
      console.log(`rin ${action} complete: ${unit}`)
      return true
    } catch {}
  }
  return false
}

async function runStart(parsed: ReturnType<typeof parseArgs>) {
  const context = daemonControlContext(parsed)
  if (tryManagedServiceAction(context, 'start')) return
  await ensureDaemonAvailable(context.repoRoot, context.targetUser, context.runtimeEnv)
  console.log('rin start complete')
}

async function runStop(parsed: ReturnType<typeof parseArgs>) {
  const context = daemonControlContext(parsed)
  if (tryManagedServiceAction(context, 'stop')) return
  try {
    const pkill = requireTool('pkill', ['/usr/bin/pkill', '/bin/pkill'])
    const daemonPattern = `${context.installDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/app/.*/dist/(app/rin-daemon/daemon\\.js|daemon\\.js)`
    const stop = buildUserShell(context.targetUser, [pkill, '-f', daemonPattern], context.runtimeEnv)
    execFileSync(stop.command, stop.args, { stdio: 'ignore', env: stop.env, cwd: context.repoRoot })
  } catch {}
  console.log('rin stop complete')
}

function captureAsTargetUser(targetUser: string, argv: string[], env: Record<string, string>) {
  const launch = buildUserShell(targetUser, argv, env)
  return execFileSync(launch.command, launch.args, { encoding: 'utf8', env: launch.env, cwd: repoRootFromHere() })
}

async function runDoctor(parsed: ReturnType<typeof parseArgs>) {
  const context = daemonControlContext(parsed)
  const socketReady = await canConnectSocketAsTargetUser(context.targetUser, context.socketPath)
  const lines = [
    `targetUser=${context.targetUser}`,
    `installDir=${context.installDir}`,
    `socketPath=${context.socketPath}`,
    `socketReady=${socketReady ? 'yes' : 'no'}`,
    `serviceManager=${context.systemctl ? 'systemd-user' : 'none'}`,
  ]

  if (context.systemctl) {
    for (const unit of [`rin-daemon-${context.targetUser}.service`, 'rin-daemon.service']) {
      try {
        const status = captureAsTargetUser(context.targetUser, [context.systemctl, '--user', 'status', unit, '--no-pager', '-l'], context.runtimeEnv)
        lines.push(`serviceUnit=${unit}`, 'serviceStatus:', ...String(status).trim().split(/\r?\n/).slice(0, 20))
        break
      } catch (error: any) {
        const text = String(error?.stdout || error?.stderr || error?.message || '').trim()
        if (text) {
          lines.push(`serviceUnit=${unit}`, 'serviceStatus:', ...text.split(/\r?\n/).slice(0, 20))
          break
        }
      }
    }
    for (const unit of [`rin-daemon-${context.targetUser}.service`, 'rin-daemon.service']) {
      try {
        const journal = captureAsTargetUser(context.targetUser, ['journalctl', '--user', '-u', unit, '-n', '20', '--no-pager'], context.runtimeEnv)
        if (String(journal || '').trim()) {
          lines.push(`serviceJournal=${unit}`, ...String(journal).trim().split(/\r?\n/).slice(-20))
          break
        }
      } catch {}
    }
  }

  console.log(lines.join('\n'))
}

async function runRestart(parsed: ReturnType<typeof parseArgs>) {
  const context = daemonControlContext(parsed)
  if (tryManagedServiceAction(context, 'restart')) return
  await runStop(parsed)
  await runStart(parsed)
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
    refreshManagedServiceFiles(parsed.targetUser, installDir)
    await runRestart(parsed)
    console.log(`rin update complete: ${releaseRoot}`)
  } finally {
    try { fs.rmSync(currentTmpLink, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
  }
}

function usage() {
  console.log([
    'Usage: rin [update|upgrade|start|stop|restart|doctor] [--user <name>|-u <name>] [--std] [--tmux <session>|-t <session>] [--tmux-list]',
    '',
    'Defaults to the RPC TUI for the target user.',
    'Commands:',
    '  update, upgrade      Upgrade the installed Rin runtime from GitHub main',
    '  start                Start the target user daemon',
    '  stop                 Stop the target user daemon',
    '  restart              Restart the target user daemon',
    '  doctor               Show daemon/socket diagnostics for the target user',
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
    if (!command && ['start', 'stop', 'restart', 'doctor'].includes(arg)) {
      command = arg
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
  if (parsed.command === 'start') {
    await runStart(parsed)
    return
  }
  if (parsed.command === 'stop') {
    await runStop(parsed)
    return
  }
  if (parsed.command === 'restart') {
    await runRestart(parsed)
    return
  }
  if (parsed.command === 'doctor') {
    await runDoctor(parsed)
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
    const socketPath = socketPathForUser(targetUser)
    if (!(await canConnectSocketAsTargetUser(targetUser, socketPath))) {
      throw new Error(`rin_daemon_unavailable: daemon is not running for ${targetUser}; run 'rin doctor${parsed.explicitUser ? ` -u ${targetUser}` : ''}' first`)
    }
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

