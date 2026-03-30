#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { cac } from 'cac'

import { finalizeInstallPlan, detectCurrentUser } from '../rin-install/main.js'
import { PI_AGENT_DIR_ENV, RIN_DIR_ENV } from '../rin-lib/runtime.js'
import { buildUserShell, homeForUser, pickPrivilegeCommand, readPasswdUser, shellQuote, socketPathForUser, targetUserRuntimeEnv } from '../rin-lib/system.js'

function safeString(value: unknown) {
  if (value == null) return ''
  return String(value)
}

function repoRootFromHere() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
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

type TargetExecutionContext = ReturnType<typeof daemonControlContext> & {
  currentUser: string
  isTargetUser: boolean
  exec: (argv: string[], options?: any) => void
  capture: (argv: string[], options?: any) => string
  canConnectSocket: () => Promise<boolean>
  queryDaemonStatus: () => Promise<any>
}

function createTargetExecutionContext(parsed: ParsedArgs): TargetExecutionContext {
  const base = daemonControlContext(parsed)
  const currentUser = os.userInfo().username
  const isTargetUser = !base.targetUser || base.targetUser === currentUser

  const exec = (argv: string[], options: any = {}) => {
    const launch = buildUserShell(base.targetUser, argv, base.runtimeEnv)
    execFileSync(launch.command, launch.args, { stdio: 'inherit', env: launch.env, cwd: base.repoRoot, ...options })
  }

  const capture = (argv: string[], options: any = {}) => {
    const launch = buildUserShell(base.targetUser, argv, base.runtimeEnv)
    return execFileSync(launch.command, launch.args, { encoding: 'utf8', env: launch.env, cwd: base.repoRoot, ...options })
  }

  const canConnectSocketInContext = async () => {
    if (isTargetUser) return await canConnectSocket(base.socketPath)
    try {
      capture([
        process.execPath,
        '-e',
        `const net=require('node:net');const s=net.createConnection(${JSON.stringify(base.socketPath)});let done=false;const finish=(ok)=>{if(done)return;done=true;try{s.destroy()}catch{};process.exit(ok?0:1)};s.once('connect',()=>finish(true));s.once('error',()=>finish(false));setTimeout(()=>finish(false),500);`,
      ], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  const queryDaemonStatusInContext = async () => {
    if (!isTargetUser) {
      try {
        const raw = capture([
          process.execPath,
          '-e',
          `const net=require('node:net');const socketPath=${JSON.stringify(base.socketPath)};const socket=net.createConnection(socketPath);let buffer='';let settled=false;const finish=(value)=>{if(settled)return;settled=true;try{socket.destroy()}catch{};process.stdout.write(JSON.stringify(value===undefined?null:value));};socket.once('error',()=>finish(undefined));socket.on('data',(chunk)=>{buffer+=String(chunk);while(true){const idx=buffer.indexOf('\\n');if(idx<0)break;let line=buffer.slice(0,idx);buffer=buffer.slice(idx+1);if(line.endsWith('\\r'))line=line.slice(0,-1);if(!line.trim())continue;try{const payload=JSON.parse(line);if(payload?.type==='response'&&payload?.command==='daemon_status'){finish(payload.success===true?payload.data:undefined);return;}}catch{}}});socket.once('connect',()=>{socket.write(JSON.stringify({id:'doctor_1',type:'daemon_status'})+'\\n');setTimeout(()=>finish(undefined),1500);});`,
        ])
        const decoded = JSON.parse(String(raw || 'null'))
        return decoded == null ? undefined : decoded
      } catch {
        return undefined
      }
    }

    return await new Promise<any>((resolve) => {
      const socket = net.createConnection(base.socketPath)
      let buffer = ''
      let settled = false
      const finish = (value: any) => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch {}
        resolve(value)
      }
      socket.once('error', () => finish(undefined))
      socket.on('data', (chunk) => {
        buffer += String(chunk)
        while (true) {
          const idx = buffer.indexOf('\n')
          if (idx < 0) break
          let line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (!line.trim()) continue
          try {
            const payload = JSON.parse(line)
            if (payload?.type === 'response' && payload?.command === 'daemon_status') {
              finish(payload.success === true ? payload.data : undefined)
              return
            }
          } catch {}
        }
      })
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id: 'doctor_1', type: 'daemon_status' })}\n`)
        setTimeout(() => finish(undefined), 1500)
      })
    })
  }

  return {
    ...base,
    currentUser,
    isTargetUser,
    exec,
    capture,
    canConnectSocket: canConnectSocketInContext,
    queryDaemonStatus: queryDaemonStatusInContext,
  }
}

async function ensureDaemonAvailable(context: TargetExecutionContext) {
  if (await context.canConnectSocket()) return

  if (context.systemctl) {
    for (const unit of [`rin-daemon-${context.targetUser}.service`, 'rin-daemon.service']) {
      try {
        context.exec([context.systemctl, '--user', 'start', unit])
        break
      } catch {}
    }
    const startedAt = Date.now()
    while (Date.now() - startedAt < 5000) {
      if (await context.canConnectSocket()) return
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  const daemonEntry = path.join(context.repoRoot, 'dist', 'app', 'rin-daemon', 'daemon.js')
  const launch = buildUserShell(context.targetUser, [process.execPath, daemonEntry], context.runtimeEnv)
  const child = spawn(launch.command, launch.args, {
    cwd: context.repoRoot,
    env: launch.env,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    if (await context.canConnectSocket()) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  throw new Error(`rin_daemon_unavailable: failed to start daemon for ${context.targetUser}`)
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

function isPermissionError(error: unknown) {
  const code = String((error as any)?.code || '')
  const message = safeString((error as any)?.message || error)
  return code === 'EACCES' || code === 'EPERM' || /permission denied/i.test(message)
}

function updateWorkRoot() {
  const base = safeString(process.env.XDG_CACHE_HOME).trim() || path.join(os.homedir(), '.cache')
  const dir = path.join(base, 'rin-update')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function runPrivileged(command: string, args: string[], options: any = {}) {
  const privilegeCommand = pickPrivilegeCommand()
  execFileSync(privilegeCommand, [command, ...args], { stdio: 'inherit', ...options })
}

function syncTree(sourcePath: string, destPath: string) {
  runCommandSync('rm', ['-rf', destPath])
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  runCommandSync('cp', ['-a', sourcePath, destPath])
}

function syncTreePrivileged(sourcePath: string, destPath: string) {
  runPrivileged('rm', ['-rf', destPath])
  runPrivileged('mkdir', ['-p', path.dirname(destPath)])
  runPrivileged('cp', ['-a', sourcePath, destPath])
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
    const content = buildSystemdServiceText(targetUser, target.home, installDir, entry.description)
    try {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true })
      fs.writeFileSync(entry.path, content, { encoding: 'utf8', mode: 0o644 })
      fs.chmodSync(entry.path, 0o644)
    } catch (error) {
      if (!isPermissionError(error)) throw error
      const privilegeCommand = pickPrivilegeCommand()
      execFileSync(privilegeCommand, ['sh', '-lc', `mkdir -p ${shellQuote(path.dirname(entry.path))} && cat > ${shellQuote(entry.path)} && chmod 0644 ${shellQuote(entry.path)}`], {
        stdio: ['pipe', 'inherit', 'inherit'],
        input: content,
      })
    }
  }
}

function resolveInstallDirForTarget(parsed: ParsedArgs) {
  const target = readPasswdUser(parsed.targetUser)
  return parsed.installDir || path.join(target?.home || os.homedir(), '.rin')
}

function daemonControlContext(parsed: ParsedArgs) {
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

function tryManagedServiceAction(context: TargetExecutionContext, action: 'start' | 'stop' | 'restart') {
  if (!context.systemctl) return false
  try {
    context.capture([context.systemctl, '--user', 'daemon-reload'], { stdio: 'ignore' })
  } catch {}
  for (const unit of [`rin-daemon-${context.targetUser}.service`, 'rin-daemon.service']) {
    try {
      context.capture([context.systemctl, '--user', 'status', unit], { stdio: 'ignore' })
      const effectiveAction = action === 'start' ? 'restart' : action
      context.exec([context.systemctl, '--user', effectiveAction, unit])
      console.log(`rin ${action} complete: ${unit}`)
      return true
    } catch {}
  }
  return false
}

async function runStart(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed)
  if (tryManagedServiceAction(context, 'start')) return
  await ensureDaemonAvailable(context)
  console.log('rin start complete')
}

async function runStop(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed)
  if (tryManagedServiceAction(context, 'stop')) return
  try {
    const pkill = requireTool('pkill', ['/usr/bin/pkill', '/bin/pkill'])
    const daemonPattern = `${context.installDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/app/.*/dist/(app/rin-daemon/daemon\\.js|daemon\\.js)`
    context.capture([pkill, '-f', daemonPattern], { stdio: 'ignore' })
  } catch {}
  console.log('rin stop complete')
}


async function runDoctor(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed)
  const socketReady = await context.canConnectSocket()
  const daemonStatus = socketReady ? await context.queryDaemonStatus() : undefined
  const webSearchStatus = daemonStatus?.webSearch
  const koishiStatus = daemonStatus?.koishi
  const lines = [
    `targetUser=${context.targetUser}`,
    `installDir=${context.installDir}`,
    `socketPath=${context.socketPath}`,
    `socketReady=${socketReady ? 'yes' : 'no'}`,
    `serviceManager=${context.systemctl ? 'systemd-user' : 'none'}`,
  ]

  lines.push(
    `webSearchRuntimeReady=${webSearchStatus?.runtime?.ready ? 'yes' : 'no'}`,
    `webSearchInstanceCount=${String(Array.isArray(webSearchStatus?.instances) ? webSearchStatus.instances.length : 0)}`,
  )
  for (const instance of Array.isArray(webSearchStatus?.instances) ? webSearchStatus.instances : []) {
    lines.push(`webSearchInstance=${instance.instanceId} pid=${String(instance.pid || 0)} alive=${instance.alive ? 'yes' : 'no'} port=${String(instance.port || '')} baseUrl=${instance.baseUrl || ''}`)
  }

  lines.push(`koishiInstanceCount=${String(Array.isArray(koishiStatus?.instances) ? koishiStatus.instances.length : 0)}`)
  for (const instance of Array.isArray(koishiStatus?.instances) ? koishiStatus.instances : []) {
    lines.push(`koishiInstance=${instance.instanceId} pid=${String(instance.pid || 0)} alive=${instance.alive ? 'yes' : 'no'} entry=${instance.entryPath || ''}`)
  }

  if (daemonStatus) {
    lines.push(
      `daemonWorkerCount=${String(daemonStatus.workerCount ?? 0)}`,
      `daemonCatalogWorkerId=${String(daemonStatus.catalogWorkerId || '')}`,
    )
    const workerLines = Array.isArray(daemonStatus.workers) ? daemonStatus.workers.map((worker: any) => {
      const sessionFile = worker.sessionFile ? String(worker.sessionFile) : '-'
      return `daemonWorker=${String(worker.id)} pid=${String(worker.pid)} role=${String(worker.role)} attached=${String(worker.attachedConnections)} pending=${String(worker.pendingResponses)} streaming=${String(worker.isStreaming)} compacting=${String(worker.isCompacting)} session=${sessionFile}`
    }) : []
    lines.push(...workerLines)
  }

  if (context.systemctl) {
    for (const unit of [`rin-daemon-${context.targetUser}.service`, 'rin-daemon.service']) {
      try {
        const status = context.capture([context.systemctl, '--user', 'status', unit, '--no-pager', '-l'])
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
        const journal = context.capture(['journalctl', '--user', '-u', unit, '-n', '20', '--no-pager'])
        if (String(journal || '').trim()) {
          lines.push(`serviceJournal=${unit}`, ...String(journal).trim().split(/\r?\n/).slice(-20))
          break
        }
      } catch {}
    }
  }

  console.log(lines.join('\n'))
}

async function runRestart(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed)
  if (tryManagedServiceAction(context, 'restart')) return
  await runStop(parsed)
  await runStart(parsed)
  console.log('rin restart complete')
}

async function runUpdate(parsed: ParsedArgs) {
  const installDir = resolveInstallDirForTarget(parsed)

  const curl = process.platform === 'win32' ? '' : (fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : '')
  const wget = process.platform === 'win32' ? '' : (fs.existsSync('/usr/bin/wget') ? '/usr/bin/wget' : '')
  const tar = requireTool('tar', ['/usr/bin/tar', '/bin/tar'])
  const npm = requireTool('npm', ['/usr/bin/npm', '/bin/npm'])
  const tempRoot = fs.mkdtempSync(path.join(updateWorkRoot(), 'work-'))
  const tmpDir = path.join(tempRoot, 'tmp')
  const archivePath = path.join(tempRoot, 'rin.tar.gz')
  const sourceRoot = path.join(tempRoot, 'src')
  const buildEnv = { ...process.env, TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir }

  try {
    fs.mkdirSync(sourceRoot, { recursive: true })
    fs.mkdirSync(tmpDir, { recursive: true })
    if (curl) {
      runCommandSync(curl, ['-fsSL', 'https://github.com/THE-cattail/rin/archive/refs/heads/main.tar.gz', '-o', archivePath])
    } else if (wget) {
      runCommandSync(wget, ['-qO', archivePath, 'https://github.com/THE-cattail/rin/archive/refs/heads/main.tar.gz'])
    } else {
      throw new Error('rin_missing_required_tool:curl_or_wget')
    }
    runCommandSync(tar, ['-xzf', archivePath, '-C', sourceRoot, '--strip-components=1'])

    if (fs.existsSync(path.join(sourceRoot, 'package-lock.json'))) {
      runCommandSync(npm, ['ci', '--no-fund', '--no-audit'], { cwd: sourceRoot, env: buildEnv })
    } else {
      runCommandSync(npm, ['install', '--no-fund', '--no-audit'], { cwd: sourceRoot, env: buildEnv })
    }
    runCommandSync(npm, ['run', 'build'], { cwd: sourceRoot, env: buildEnv })

    const result = await finalizeInstallPlan({
      currentUser: detectCurrentUser(),
      targetUser: parsed.targetUser,
      installDir,
      sourceRoot,
    })
    console.log(`rin update complete: ${result.publishedRuntime.releaseRoot}`)
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
  }
}

type ParsedArgs = {
  command: '' | 'start' | 'stop' | 'restart' | 'doctor'
  targetUser: string
  installDir: string
  std: boolean
  tmuxSession: string
  tmuxList: boolean
  passthrough: string[]
  explicitUser: boolean
  hasSavedInstall: boolean
}

function collectTuiPassthroughArgs(argv: string[]) {
  const passthrough: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--user' || arg === '-u' || arg === '--tmux' || arg === '-t') {
      i += 1
      continue
    }
    if (arg === '--std' || arg === '--tmux-list') continue
    passthrough.push(arg)
  }
  return passthrough
}

function resolveParsedArgs(command: ParsedArgs['command'], options: any, rawArgv: string[]): ParsedArgs {
  const installConfig = loadInstallConfig()
  const targetUser = safeString(options.user).trim()
  return {
    command,
    targetUser: targetUser || safeString(installConfig.defaultTargetUser).trim() || os.userInfo().username,
    installDir: safeString(installConfig.defaultInstallDir).trim(),
    std: Boolean(options.std),
    tmuxSession: safeString(options.tmux).trim(),
    tmuxList: Boolean(options.tmuxList),
    passthrough: command ? [] : collectTuiPassthroughArgs(rawArgv),
    explicitUser: Boolean(targetUser),
    hasSavedInstall: Boolean(safeString(installConfig.defaultTargetUser).trim() || safeString(installConfig.defaultInstallDir).trim()),
  }
}

function createCli() {
  const cli = cac('rin')
  cli
    .usage('[command] [options] [-- passthrough]')
    .option('-u, --user <name>', 'Run against a specific daemon user')
    .option('--std', 'Start std TUI instead of RPC TUI')
    .option('-t, --tmux <session>', 'Create or attach a hidden Rin tmux session')
    .option('--tmux-list', 'List hidden Rin tmux sessions')
    .help()

  cli.command('start', 'Start the target user daemon')
  cli.command('stop', 'Stop the target user daemon')
  cli.command('restart', 'Restart the target user daemon')
  cli.command('doctor', 'Show daemon/socket diagnostics for the target user')

  return cli
}

export async function startRinCli() {
  const cli = createCli()
  const parsedArgv = cli.parse(process.argv, { run: false })
  if (parsedArgv.options.help) {
    cli.outputHelp()
    return
  }
  const matchedName = safeString(cli.matchedCommandName).trim()
  const command = ['start', 'stop', 'restart', 'doctor'].includes(matchedName)
    ? matchedName as ParsedArgs['command']
    : ''
  const parsed = resolveParsedArgs(command, parsedArgv.options, process.argv.slice(2))
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

