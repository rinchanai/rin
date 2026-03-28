#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { cancel, confirm, intro, isCancel, note, outro, select, spinner, text } from '@clack/prompts'

import { loadRinCodingAgent } from '../rin-lib/loader.js'

function listSystemUsers() {
  const users: Array<{ name: string; uid: number; gid: number; home: string; shell: string }> = []

  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('dscl', ['.', '-list', '/Users', 'UniqueID'], { encoding: 'utf8' })
      for (const line of raw.split(/\r?\n/)) {
        const match = line.trim().match(/^(\S+)\s+(\d+)$/)
        if (!match) continue
        const [, name, uidRaw] = match
        const uid = Number(uidRaw || 0)
        if (!name || !Number.isFinite(uid) || uid < 500) continue
        if (name === 'nobody') continue
        let home = ''
        let shell = ''
        let gid = 20
        try {
          const detail = execFileSync('dscl', ['.', '-read', `/Users/${name}`, 'NFSHomeDirectory', 'UserShell', 'PrimaryGroupID'], { encoding: 'utf8' })
          for (const detailLine of detail.split(/\r?\n/)) {
            if (detailLine.startsWith('NFSHomeDirectory:')) home = detailLine.replace(/^NFSHomeDirectory:\s*/, '').trim()
            if (detailLine.startsWith('UserShell:')) shell = detailLine.replace(/^UserShell:\s*/, '').trim()
            if (detailLine.startsWith('PrimaryGroupID:')) gid = Number(detailLine.replace(/^PrimaryGroupID:\s*/, '').trim() || 20)
          }
        } catch {}
        if (/nologin|false/.test(shell)) continue
        users.push({ name, uid, gid, home, shell })
      }
    } catch {}
    return users.sort((a, b) => a.uid - b.uid || a.name.localeCompare(b.name))
  }

  try {
    const raw = fs.readFileSync('/etc/passwd', 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue
      const [name = '', , uidRaw = '', gidRaw = '', , home = '', shell = ''] = line.split(':')
      const uid = Number(uidRaw || 0)
      const gid = Number(gidRaw || 0)
      if (!name) continue
      if (!Number.isFinite(uid) || !Number.isFinite(gid)) continue
      if (uid < 1000) continue
      if (name === 'nobody') continue
      if (/nologin|false/.test(shell)) continue
      users.push({ name, uid, gid, home, shell } as any)
    }
  } catch {}
  return users.sort((a, b) => a.uid - b.uid || a.name.localeCompare(b.name))
}

function ensureNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Installer cancelled.')
    process.exit(1)
  }
  return value as T
}

function detectCurrentUser() {
  const candidates = [
    process.env.SUDO_USER,
    process.env.LOGNAME,
    process.env.USER,
    (() => {
      try { return os.userInfo().username } catch { return '' }
    })(),
  ].map((value) => String(value || '').trim()).filter(Boolean)
  return candidates[0] || 'unknown'
}

function findSystemUser(targetUser: string) {
  return listSystemUsers().find((entry) => entry.name === targetUser)
}

function targetHomeForUser(targetUser: string) {
  const matched = findSystemUser(targetUser)
  return matched?.home || path.join(process.platform === 'darwin' ? '/Users' : '/home', targetUser)
}

function summarizeDirState(dir: string) {
  try {
    const entries = fs.readdirSync(dir)
    return {
      exists: true,
      entryCount: entries.length,
      sample: entries.slice(0, 8),
    }
  } catch {
    return {
      exists: false,
      entryCount: 0,
      sample: [] as string[],
    }
  }
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function repoRootFromHere() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function readJsonFileWithPrivilege<T>(filePath: string, fallback: T): T {
  const privilegeCommand = pickPrivilegeCommand()
  try {
    const raw = execFileSync(privilegeCommand, ['cat', filePath], { encoding: 'utf8' })
    return JSON.parse(String(raw || '')) as T
  } catch {
    return fallback
  }
}

function readInstallerJson<T>(filePath: string, fallback: T, elevated = false): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch (error: any) {
    const code = String(error?.code || '')
    if (code === 'EACCES' || code === 'EPERM') {
      if (!elevated) throw error
      return readJsonFileWithPrivilege(filePath, fallback)
    }
    return fallback
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeTextFile(filePath: string, value: string, mode = 0o600) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, 'utf8')
  fs.chmodSync(filePath, mode)
}

function appConfigDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'rin')
  return path.join(os.homedir(), '.config', 'rin')
}

function pickPrivilegeCommand() {
  if (process.platform !== 'win32' && fs.existsSync('/run/current-system/sw/bin/doas')) return '/run/current-system/sw/bin/doas'
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/doas')) return '/usr/bin/doas'
  if (process.platform !== 'win32' && fs.existsSync('/bin/doas')) return '/bin/doas'
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/sudo')) return '/usr/bin/sudo'
  if (process.platform !== 'win32' && fs.existsSync('/bin/sudo')) return '/bin/sudo'
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/pkexec')) return '/usr/bin/pkexec'
  return 'sudo'
}

function runPrivileged(command: string, args: string[]) {
  const privilegeCommand = pickPrivilegeCommand()
  execFileSync(privilegeCommand, [command, ...args], { stdio: 'inherit' })
}

function runCommandAsUser(targetUser: string, command: string, args: string[], extraEnv: Record<string, string> = {}) {
  const envArgs = Object.entries(extraEnv).map(([key, value]) => `${key}=${JSON.stringify(value)}`)
  const shellCommand = [...envArgs, JSON.stringify(command), ...args.map((arg) => JSON.stringify(arg))].join(' ')
  const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false

  if (isRoot && fs.existsSync('/usr/sbin/runuser')) {
    execFileSync('/usr/sbin/runuser', ['-u', targetUser, '--', 'sh', '-lc', shellCommand], { stdio: 'inherit' })
    return
  }

  const privilegeCommand = pickPrivilegeCommand()
  if (privilegeCommand.endsWith('doas') || privilegeCommand.endsWith('sudo')) {
    execFileSync(privilegeCommand, ['-u', targetUser, 'sh', '-lc', shellCommand], { stdio: 'inherit' })
    return
  }

  execFileSync(privilegeCommand, ['sh', '-lc', shellCommand], { stdio: 'inherit' })
}

function writeTextFileWithPrivilege(filePath: string, value: string, ownerUser?: string, ownerGroup?: string | number, mode = 0o600) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-install-write-'))
  const tempFile = path.join(tempDir, 'payload')
  try {
    fs.writeFileSync(tempFile, value, 'utf8')
    runPrivileged('mkdir', ['-p', path.dirname(filePath)])
    runPrivileged('install', ['-m', String(mode.toString(8)), tempFile, filePath])
    if (ownerUser && process.platform !== 'win32') {
      const owner = ownerGroup != null && `${ownerGroup}` !== '' ? `${ownerUser}:${ownerGroup}` : ownerUser
      runPrivileged('chown', [owner, filePath])
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function writeJsonFileWithPrivilege(filePath: string, value: unknown, ownerUser?: string, ownerGroup?: string | number) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-install-write-'))
  const tempFile = path.join(tempDir, 'payload.json')
  const privilegeCommand = pickPrivilegeCommand()
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    execFileSync(privilegeCommand, ['mkdir', '-p', path.dirname(filePath)], { stdio: 'inherit' })
    execFileSync(privilegeCommand, ['install', '-m', '600', tempFile, filePath], { stdio: 'inherit' })
    if (ownerUser && process.platform !== 'win32') {
      const owner = ownerGroup != null && `${ownerGroup}` !== '' ? `${ownerUser}:${ownerGroup}` : ownerUser
      execFileSync(privilegeCommand, ['chown', owner, filePath], { stdio: 'inherit' })
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function computeAvailableThinkingLevels(model: { provider: string; id: string; reasoning: boolean }) {
  if (!model.reasoning) return ['off']
  const id = String(model.id || '').toLowerCase()
  const provider = String(model.provider || '').toLowerCase()
  return provider === 'openai' && id.includes('codex-max')
    ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
    : ['off', 'minimal', 'low', 'medium', 'high']
}

async function loadModelChoices() {
  const { getProviders, getModels } = await import('@mariozechner/pi-ai')
  const merged = new Map<string, { provider: string; id: string; reasoning: boolean; available: boolean }>()

  for (const provider of getProviders()) {
    for (const model of getModels(provider as any)) {
      merged.set(`${(model as any).provider || provider}/${(model as any).id || ''}`, {
        provider: String((model as any).provider || provider),
        id: String((model as any).id || ''),
        reasoning: Boolean((model as any).reasoning),
        available: false,
      })
    }
  }

  const choices = [...merged.values()].filter((model) => model.provider && model.id)
  choices.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
  return choices
}

async function createInstallerAuthStorage(installDir: string) {
  const codingAgentModule = await loadRinCodingAgent()
  const { AuthStorage } = codingAgentModule as any
  const authPath = path.join(installDir, 'auth.json')
  const existing = readJsonFile<any>(authPath, {})
  return AuthStorage.inMemory(existing)
}

async function configureProviderAuth(provider: string, installDir: string) {
  const authStorage = await createInstallerAuthStorage(installDir)
  if (authStorage.hasAuth?.(provider)) {
    return { available: true, authKind: 'existing', authData: authStorage.getAll?.() || {} }
  }

  const oauthProviders = Array.isArray(authStorage.getOAuthProviders?.()) ? authStorage.getOAuthProviders() : []
  const oauthProvider = oauthProviders.find((entry: any) => entry.id === provider)

  if (oauthProvider) {
    const loginSpinner = spinner()
    let lastAuthUrl = ''
    loginSpinner.start(`Starting ${oauthProvider.name || provider} login...`)
    try {
      await authStorage.login(provider, {
        onAuth(info: { url: string; instructions?: string }) {
          lastAuthUrl = String(info?.url || '')
          loginSpinner.stop(`Open this URL to continue login:\n${lastAuthUrl}${info?.instructions ? `\n${info.instructions}` : ''}`)
        },
        async onPrompt(prompt: { message: string; placeholder?: string }) {
          return String(ensureNotCancelled(await text({
            message: prompt.message || 'Enter login value.',
            placeholder: prompt.placeholder,
            validate(value) {
              if (!String(value || '').trim()) return 'A value is required.'
            },
          }))).trim()
        },
        onProgress(message: string) {
          loginSpinner.message(message || `Waiting for ${oauthProvider.name || provider} login...`)
        },
        async onManualCodeInput() {
          return String(ensureNotCancelled(await text({
            message: 'Paste the redirect URL or code from the browser.',
            placeholder: lastAuthUrl ? 'paste the final redirect URL or device code' : 'paste the code',
            validate(value) {
              if (!String(value || '').trim()) return 'A value is required.'
            },
          }))).trim()
        },
        signal: AbortSignal.timeout(10 * 60 * 1000),
      })
      loginSpinner.stop(`${oauthProvider.name || provider} login complete.`)
      return { available: true, authKind: 'oauth', authData: authStorage.getAll?.() || {} }
    } catch (error: any) {
      loginSpinner.stop(`Login failed for ${oauthProvider.name || provider}.`)
      throw error
    }
  }

  const token = String(ensureNotCancelled(await text({
    message: `Enter the API key or token for ${provider}.`,
    placeholder: 'token',
    validate(value) {
      if (!String(value || '').trim()) return 'A token is required.'
    },
  }))).trim()
  authStorage.set(provider, { type: 'api_key', key: token })
  return { available: true, authKind: 'api_key', authData: authStorage.getAll?.() || {} }
}

function resolveDaemonEntryForInstall(installDir: string) {
  const installedEntry = path.join(installDir, 'app', 'current', 'dist', 'daemon.js')
  if (fs.existsSync(installedEntry)) return installedEntry
  return path.join(repoRootFromHere(), 'dist', 'app', 'rin-daemon', 'daemon.js')
}

function buildLaunchdPlist(targetUser: string, installDir: string) {
  const label = `com.rin.daemon.${String(targetUser).replace(/[^A-Za-z0-9_.-]+/g, '-')}`
  const targetHome = targetHomeForUser(targetUser)
  const daemonEntry = resolveDaemonEntryForInstall(installDir)
  const stdoutPath = path.join(installDir, 'data', 'logs', 'daemon.stdout.log')
  const stderrPath = path.join(installDir, 'data', 'logs', 'daemon.stderr.log')
  const plistPath = path.join(targetHome, 'Library', 'LaunchAgents', `${label}.plist`)
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${process.execPath}</string>
      <string>${daemonEntry}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>RIN_DIR</key>
      <string>${installDir}</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${targetHome}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
  </dict>
</plist>
`
  return { label, plistPath, plist, stdoutPath, stderrPath }
}

function installLaunchdAgent(targetUser: string, installDir: string, elevated = false) {
  const target = findSystemUser(targetUser) as any
  const uid = Number(target?.uid ?? -1)
  if (uid < 0) throw new Error(`rin_launchd_target_user_not_found:${targetUser}`)

  const { label, plistPath, plist, stdoutPath, stderrPath } = buildLaunchdPlist(targetUser, installDir)
  if (elevated) {
    runPrivileged('mkdir', ['-p', path.dirname(plistPath)])
    runPrivileged('mkdir', ['-p', path.dirname(stdoutPath)])
    writeTextFileWithPrivilege(plistPath, plist, targetUser, target?.gid, 0o644)
    try { runPrivileged('launchctl', ['bootout', `gui/${uid}`, plistPath]) } catch {}
    runPrivileged('launchctl', ['bootstrap', `gui/${uid}`, plistPath])
    try { runPrivileged('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]) } catch {}
  } else {
    ensureDir(path.dirname(plistPath))
    ensureDir(path.dirname(stdoutPath))
    writeTextFile(plistPath, plist, 0o644)
    try { execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' }) } catch {}
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' })
    try { execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'inherit' }) } catch {}
  }

  return { kind: 'launchd' as const, label, servicePath: plistPath, stdoutPath, stderrPath }
}

function buildSystemdUserService(targetUser: string, installDir: string) {
  const daemonEntry = resolveDaemonEntryForInstall(installDir)
  const targetHome = targetHomeForUser(targetUser)
  const unitName = `rin-daemon-${String(targetUser).replace(/[^A-Za-z0-9_.@-]+/g, '-')}.service`
  const unitPath = path.join(targetHome, '.config', 'systemd', 'user', unitName)
  const service = `[Unit]
Description=Rin daemon for ${targetUser}
After=network.target

[Service]
Type=simple
WorkingDirectory=${targetHome}
Environment=RIN_DIR=${installDir}
ExecStart=${process.execPath} ${daemonEntry}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
  return { kind: 'systemd' as const, label: unitName, servicePath: unitPath, service }
}

function installSystemdUserService(targetUser: string, installDir: string, elevated = false) {
  const target = findSystemUser(targetUser) as any
  const spec = buildSystemdUserService(targetUser, installDir)
  const systemctl = fs.existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : 'systemctl'
  const loginctl = fs.existsSync('/usr/bin/loginctl') ? '/usr/bin/loginctl' : 'loginctl'
  const uid = Number(target?.uid ?? -1)
  const runtimeDir = uid >= 0 ? `/run/user/${uid}` : ''
  const userEnv = runtimeDir && fs.existsSync(runtimeDir)
    ? { XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` }
    : {}

  if (elevated) {
    writeTextFileWithPrivilege(spec.servicePath, spec.service, targetUser, target?.gid, 0o644)
    try { runPrivileged(loginctl, ['enable-linger', targetUser]) } catch {}
    runCommandAsUser(targetUser, systemctl, ['--user', 'daemon-reload'], userEnv)
    runCommandAsUser(targetUser, systemctl, ['--user', 'enable', '--now', spec.label], userEnv)
  } else {
    writeTextFile(spec.servicePath, spec.service, 0o644)
    execFileSync(systemctl, ['--user', 'daemon-reload'], { stdio: 'inherit', env: { ...process.env, ...userEnv } })
    execFileSync(systemctl, ['--user', 'enable', '--now', spec.label], { stdio: 'inherit', env: { ...process.env, ...userEnv } })
  }

  return spec
}

function installDaemonService(targetUser: string, installDir: string, elevated = false) {
  if (process.platform === 'darwin') return installLaunchdAgent(targetUser, installDir, elevated)
  if (process.platform === 'linux' && (fs.existsSync('/usr/bin/systemctl') || fs.existsSync('/bin/systemctl'))) {
    return installSystemdUserService(targetUser, installDir, elevated)
  }
  throw new Error(`rin_service_install_unsupported:${process.platform}`)
}

function describeOwnership(targetUser: string, installDir: string) {
  const target = findSystemUser(targetUser) as any
  const targetUid = Number(target?.uid ?? -1)
  const targetGid = Number(target?.gid ?? -1)

  try {
    const stat = fs.statSync(installDir)
    let writable = true
    try {
      fs.accessSync(installDir, fs.constants.W_OK)
    } catch {
      writable = false
    }
    return {
      ownerMatches: targetUid >= 0 ? stat.uid === targetUid : true,
      writable,
      statUid: stat.uid,
      statGid: stat.gid,
      targetUid,
      targetGid,
    }
  } catch {
    return {
      ownerMatches: true,
      writable: true,
      statUid: -1,
      statGid: -1,
      targetUid,
      targetGid,
    }
  }
}

async function persistInstallerOutputs(options: {
  currentUser: string
  targetUser: string
  installDir: string
  provider: string
  modelId: string
  thinkingLevel: string
  koishiDescription: string
  koishiDetail: string
  koishiConfig: any
  authData: any
  elevated?: boolean
}) {
  const target = findSystemUser(options.targetUser) as any
  const ownerUser = target?.name || options.targetUser
  const ownerGroup = target?.gid
  if (!options.elevated) ensureDir(options.installDir)

  const settingsPath = path.join(options.installDir, 'settings.json')
  const settingsJson = readInstallerJson<any>(settingsPath, {}, Boolean(options.elevated))
  if (options.provider) settingsJson.defaultProvider = options.provider
  if (options.modelId) settingsJson.defaultModel = options.modelId
  if (options.thinkingLevel) settingsJson.defaultThinkingLevel = options.thinkingLevel
  if (options.koishiConfig) {
    settingsJson.koishi ||= {}
    if (options.koishiConfig.telegram) settingsJson.koishi.telegram = options.koishiConfig.telegram
    if (options.koishiConfig.onebot) settingsJson.koishi.onebot = options.koishiConfig.onebot
  }

  const authPath = path.join(options.installDir, 'auth.json')
  const authJson = readInstallerJson<any>(authPath, {}, Boolean(options.elevated))
  const nextAuthJson = { ...authJson, ...(options.authData || {}) }

  const launcherPath = path.join(appConfigDir(), 'install.json')
  const launcherJson = readJsonFile<any>(launcherPath, {})
  launcherJson.defaultTargetUser = options.targetUser
  launcherJson.defaultInstallDir = options.installDir
  launcherJson.updatedAt = new Date().toISOString()
  launcherJson.installedBy = options.currentUser

  const manifestPath = path.join(options.installDir, 'config', 'installer.json')
  const manifestJson = readInstallerJson<any>(manifestPath, {}, Boolean(options.elevated))
  manifestJson.targetUser = options.targetUser
  manifestJson.installDir = options.installDir
  if (options.provider) manifestJson.defaultProvider = options.provider
  if (options.modelId) manifestJson.defaultModel = options.modelId
  if (options.thinkingLevel) manifestJson.defaultThinkingLevel = options.thinkingLevel
  manifestJson.koishi = options.koishiConfig || {}
  manifestJson.updatedAt = new Date().toISOString()

  if (options.elevated) {
    writeJsonFileWithPrivilege(settingsPath, settingsJson, ownerUser, ownerGroup)
    writeJsonFileWithPrivilege(authPath, nextAuthJson, ownerUser, ownerGroup)
    writeJsonFileWithPrivilege(manifestPath, manifestJson, ownerUser, ownerGroup)
  } else {
    writeJsonFile(settingsPath, settingsJson)
    writeJsonFile(authPath, nextAuthJson)
    writeJsonFile(manifestPath, manifestJson)
  }
  writeJsonFile(launcherPath, launcherJson)

  return { settingsPath, authPath, launcherPath, manifestPath }
}

export async function startInstaller() {
  const currentUser = detectCurrentUser()
  const allUsers = listSystemUsers()
  const otherUsers = allUsers.filter((entry) => entry.name !== currentUser)
  const existingCandidates = otherUsers.length ? otherUsers : allUsers.filter((entry) => entry.name !== currentUser).length ? allUsers.filter((entry) => entry.name !== currentUser) : allUsers

  intro('Rin Installer')

  const targetMode = ensureNotCancelled(await select({
    message: 'Choose the target user for the Rin daemon.',
    options: [
      { value: 'current', label: `Current user`, hint: currentUser },
      { value: 'existing', label: 'Existing other user', hint: existingCandidates.length ? `${existingCandidates.length} user(s)` : 'none found' },
      { value: 'new', label: 'New user', hint: 'enter a username' },
    ],
  }))

  let targetUser = currentUser
  if (targetMode === 'existing') {
    if (!existingCandidates.length) {
      note([
        'No eligible existing users were found on this system.',
        `Detected current user: ${currentUser}`,
        `Visible users: ${allUsers.map((entry) => entry.name).join(', ') || 'none'}`,
      ].join('\n'), 'Target user')
      outro('Nothing installed.')
      return
    }
    targetUser = ensureNotCancelled(await select({
      message: 'Choose the existing user to host the Rin daemon.',
      options: existingCandidates.map((entry) => ({
        value: entry.name,
        label: entry.name,
        hint: `${entry.home} · uid ${entry.uid}`,
      })),
    }))
  } else if (targetMode === 'new') {
    targetUser = ensureNotCancelled(await text({
      message: 'Enter the new username to create for the Rin daemon.',
      placeholder: 'rin',
      validate(value) {
        const next = String(value || '').trim()
        if (!next) return 'Username is required.'
        if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(next)) return 'Use a normal Unix username.'
      },
    }))
  }

  const defaultDir = path.join(targetHomeForUser(targetUser), '.rin')
  const installDir = String(ensureNotCancelled(await text({
    message: 'Choose the Rin data directory for the daemon user.',
    placeholder: defaultDir,
    defaultValue: defaultDir,
    validate(value) {
      const next = String(value || '').trim()
      if (!next) return 'Directory is required.'
      if (!path.isAbsolute(next)) return 'Use an absolute path.'
    },
  }))).trim()

  const state = summarizeDirState(installDir)
  if (state.exists) {
    note([
      `Directory exists: ${installDir}`,
      `Existing entries: ${state.entryCount}`,
      state.sample.length ? `Sample: ${state.sample.join(', ')}` : '',
      '',
      'Installer policy:',
      '- keep unknown files untouched',
      '- keep existing config unless a required file must be updated',
      '- only remove old files when they are known legacy Rin artifacts',
    ].filter(Boolean).join('\n'), 'Existing directory')
  } else {
    note([
      `Directory will be created: ${installDir}`,
      '',
      'Installer policy:',
      '- create only the files Rin needs',
      '- future updates should preserve unknown files',
    ].join('\n'), 'Install directory')
  }

  const shouldConfigureProvider = ensureNotCancelled(await confirm({
    message: 'Configure a provider now?',
    initialValue: true,
  }))

  let provider = ''
  let modelId = ''
  let thinkingLevel = ''
  let authResult: any = { available: false, authKind: 'skipped', authData: {} }

  if (shouldConfigureProvider) {
    const loadSpinner = spinner()
    loadSpinner.start('Loading provider and model choices...')
    const models = await loadModelChoices()
    loadSpinner.stop('Provider and model choices loaded.')

    const providerNames = [...new Set(models.map((model) => model.provider).filter(Boolean))]
    if (!providerNames.length) {
      throw new Error('rin_installer_no_models_available')
    }

    provider = String(ensureNotCancelled(await select({
      message: 'Choose a provider to authenticate and use.',
      options: providerNames.map((name) => {
        const scoped = models.filter((model) => model.provider === name)
        const availableCount = scoped.filter((model) => model.available).length
        return {
          value: name,
          label: name,
          hint: availableCount ? `${availableCount}/${scoped.length} ready` : `${scoped.length} models`,
        }
      }),
    })))

    authResult = await configureProviderAuth(String(provider), installDir)

    const providerModels = models.filter((model) => model.provider === provider)
    if (!providerModels.length) {
      throw new Error(`rin_installer_no_models_for_provider:${provider}`)
    }
    modelId = String(ensureNotCancelled(await select({
      message: 'Choose a model.',
      options: providerModels.map((model) => ({
        value: model.id,
        label: model.id,
        hint: [authResult.available || model.available ? 'ready' : 'needs auth/config', model.reasoning ? 'reasoning' : 'no reasoning'].join(' · '),
      })),
    })))

    const model = providerModels.find((entry) => entry.id === modelId)!
    thinkingLevel = String(ensureNotCancelled(await select({
      message: 'Choose the default thinking level.',
      options: computeAvailableThinkingLevels(model).map((level) => ({
        value: level,
        label: level,
      })),
    })))
  }

  const enableKoishi = ensureNotCancelled(await confirm({
    message: 'Configure a Koishi adapter now?',
    initialValue: false,
  }))

  let koishiDescription = 'disabled for now'
  let koishiDetail = ''
  let koishiConfig: any = null
  if (enableKoishi) {
    const adapter = ensureNotCancelled(await select({
      message: 'Choose a Koishi adapter.',
      options: [
        { value: 'telegram', label: 'Telegram', hint: 'bot token' },
        { value: 'onebot', label: 'OneBot', hint: 'endpoint URL' },
      ],
    })) as 'telegram' | 'onebot'

    koishiDescription = adapter
    if (adapter === 'telegram') {
      const token = String(ensureNotCancelled(await text({
        message: 'Enter the Telegram bot token.',
        placeholder: '123456:ABCDEF...',
        validate(value) {
          if (!String(value || '').trim()) return 'Token is required.'
        },
      }))).trim()
      koishiDetail = 'Koishi token: [saved to target settings.json]'
      koishiConfig = { telegram: { token, protocol: 'polling', slash: true } }
    } else {
      const endpoint = String(ensureNotCancelled(await text({
        message: 'Enter the OneBot endpoint URL.',
        placeholder: 'http://127.0.0.1:5700',
        validate(value) {
          const next = String(value || '').trim()
          if (!next) return 'Endpoint is required.'
          try {
            new URL(next)
          } catch {
            return 'Use a valid URL.'
          }
        },
      }))).trim()
      koishiDetail = `Koishi endpoint: ${endpoint}`
      koishiConfig = { onebot: { endpoint, protocol: endpoint.startsWith('ws') ? 'ws' : 'http', selfId: '', token: '' } }
    }
  }

  note([
    `Current user: ${currentUser}`,
    `Target daemon user: ${targetUser}`,
    `Install dir: ${installDir}`,
    `Provider: ${provider || 'skipped for now'}`,
    `Model: ${modelId || 'skipped for now'}`,
    `Thinking level: ${thinkingLevel || 'skipped for now'}`,
    `Model auth status: ${provider ? (authResult.available ? 'ready' : 'needs auth/config later') : 'skipped for now'}`,
    `Koishi: ${koishiDescription}`,
    koishiDetail,
    '',
    'Planned command shape:',
    '- `rin` → RPC TUI for the target user',
    '- `rin --std` → std TUI for the target user',
    '- `rin --tmux <session_name>` → attach/create a hidden Rin tmux session for the target user',
    '- `rin --tmux-list` → list Rin tmux sessions for the target user',
    '',
    'Safety reminder:',
    '- This agent runs with the full permissions of its system user account.',
    '- Treat it like a shell-capable operator on that account and use it carefully.',
  ].filter(Boolean).join('\n'), 'Install plan')

  const ownership = describeOwnership(targetUser, installDir)
  if (!ownership.ownerMatches && ownership.targetUid >= 0) {
    note([
      `Target dir owner uid/gid: ${ownership.statUid}:${ownership.statGid}`,
      `Target user uid/gid: ${ownership.targetUid}:${ownership.targetGid}`,
      'This directory is not currently owned by the selected target user.',
      'The installer will still write config if it can, but you may want to fix ownership before switching fully.',
    ].join('\n'), 'Ownership check')
  }

  if (!ownership.writable) {
    note('The selected install directory is not writable by the current installer process.', 'Ownership check')
  }

  const shouldWrite = ensureNotCancelled(await confirm({
    message: 'Write these settings now?',
    initialValue: true,
  }))

  if (!shouldWrite) {
    outro('Installer finished without writing changes.')
    return
  }

  const installServiceNow = (process.platform === 'darwin' || process.platform === 'linux')
    ? ensureNotCancelled(await confirm({
        message: process.platform === 'darwin'
          ? 'Install and start a macOS launchd agent for the Rin daemon now?'
          : 'Install and start a Linux user daemon service for Rin now?',
        initialValue: true,
      }))
    : false

  let written: { settingsPath: string; authPath: string; launcherPath: string; manifestPath: string }
  let installedService: null | { kind: 'launchd' | 'systemd'; label: string; servicePath: string; stdoutPath?: string; stderrPath?: string; service?: string } = null
  const serviceHint = process.platform === 'darwin'
    ? installServiceNow
      ? 'A macOS launchd LaunchAgent will be installed and started for this daemon.'
      : 'The launcher auto-starts the daemon on demand. You skipped launchd installation for now.'
    : process.platform === 'linux'
      ? installServiceNow
        ? 'A Linux user service will be installed and started for this daemon when supported.'
        : 'The launcher auto-starts the daemon on demand. You skipped dedicated Linux service installation for now.'
      : 'The launcher auto-starts the daemon on demand; dedicated user services can be layered on later if wanted.'
  try {
    written = await persistInstallerOutputs({
      currentUser,
      targetUser,
      installDir,
      provider: String(provider),
      modelId: String(modelId),
      thinkingLevel: String(thinkingLevel),
      koishiDescription,
      koishiDetail,
      koishiConfig,
      authData: authResult.authData || {},
    })
  } catch (error: any) {
    const message = String(error?.message || error || '')
    if (/EACCES|EPERM|permission denied/i.test(message)) {
      const useSudo = ensureNotCancelled(await confirm({
        message: 'Writing these files needs elevated permissions. Use sudo to finish writing?',
        initialValue: true,
      }))
      if (!useSudo) throw error
      written = await persistInstallerOutputs({
        currentUser,
        targetUser,
        installDir,
        provider: String(provider),
        modelId: String(modelId),
        thinkingLevel: String(thinkingLevel),
        koishiDescription,
        koishiDetail,
        koishiConfig,
        authData: authResult.authData || {},
        elevated: true,
      })
      if (installServiceNow && (process.platform === 'darwin' || process.platform === 'linux')) {
        installedService = installDaemonService(targetUser, installDir, true)
      }
    } else {
      throw error
    }
  }

  if (!installedService && installServiceNow && (process.platform === 'darwin' || process.platform === 'linux')) {
    try {
      installedService = installDaemonService(targetUser, installDir)
    } catch (error: any) {
      const message = String(error?.message || error || '')
      if (/not permitted|permission denied|EACCES|EPERM|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|Failed to connect to user scope bus/i.test(message)) {
        const usePrivilegeForService = ensureNotCancelled(await confirm({
          message: 'Installing the daemon service needs privilege escalation or a target user session bus. Use privilege escalation now?',
          initialValue: true,
        }))
        if (usePrivilegeForService) {
          installedService = installDaemonService(targetUser, installDir, true)
        } else {
          throw error
        }
      } else {
        throw error
      }
    }
  }

  note([
    `Target install dir: ${installDir}`,
    `Written: ${written.settingsPath}`,
    `Written: ${written.authPath}`,
    `Written: ${written.manifestPath}`,
    `Written: ${written.launcherPath}`,
    installedService ? `Written: ${installedService.servicePath}` : '',
    installedService ? `${installedService.kind} label: ${installedService.label}` : '',
    '',
    'Default launcher behavior:',
    '- `rin` uses the saved target user and install dir',
    '- `rin` in RPC mode auto-starts the daemon when needed',
    '- `rin --std` enters std mode for that target',
    '- `rin -t <name>` attaches/creates a hidden tmux TUI session',
    '',
    `Service/platform note: ${serviceHint}`,
    '',
    'Safety reminder:',
    '- This agent runs with the full permissions of its system user account.',
    '- Treat it like a shell-capable operator on that account and use it carefully.',
  ].join('\n'), 'Written paths')

  outro(`Installer wrote config for ${targetUser}. You can start with: rin, rin --std, rin -t main${installedService ? `, and ${installedService.kind} service is installed.` : ''}`)
}

