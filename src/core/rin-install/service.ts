import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'

import { pickPrivilegeCommand } from '../rin-lib/system.js'
import { ensureDir, runCommandAsUser, runPrivileged, writeTextFile, writeTextFileWithPrivilege } from './fs-utils.js'

export function resolveDaemonEntryForInstall(installDir: string, repoRootFromHere: () => string) {
  const currentStyle = path.join(installDir, 'app', 'current', 'dist', 'app', 'rin-daemon', 'daemon.js')
  if (fs.existsSync(currentStyle)) return currentStyle
  const legacyStyle = path.join(installDir, 'app', 'current', 'dist', 'daemon.js')
  if (fs.existsSync(legacyStyle)) return legacyStyle
  return path.join(repoRootFromHere(), 'dist', 'app', 'rin-daemon', 'daemon.js')
}

export function buildLaunchdPlist(targetUser: string, installDir: string, targetHomeForUser: (user: string) => string, repoRootFromHere: () => string) {
  const label = `com.rin.daemon.${String(targetUser).replace(/[^A-Za-z0-9_.-]+/g, '-')}`
  const targetHome = targetHomeForUser(targetUser)
  const daemonEntry = resolveDaemonEntryForInstall(installDir, repoRootFromHere)
  const stdoutPath = path.join(installDir, 'data', 'logs', 'daemon.stdout.log')
  const stderrPath = path.join(installDir, 'data', 'logs', 'daemon.stderr.log')
  const plistPath = path.join(targetHome, 'Library', 'LaunchAgents', `${label}.plist`)
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${label}</string>\n    <key>ProgramArguments</key>\n    <array>\n      <string>${process.execPath}</string>\n      <string>${daemonEntry}</string>\n    </array>\n    <key>EnvironmentVariables</key>\n    <dict>\n      <key>RIN_DIR</key>\n      <string>${installDir}</string>\n    </dict>\n    <key>WorkingDirectory</key>\n    <string>${targetHome}</string>\n    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>\n    <key>StandardOutPath</key>\n    <string>${stdoutPath}</string>\n    <key>StandardErrorPath</key>\n    <string>${stderrPath}</string>\n  </dict>\n</plist>\n`
  return { label, plistPath, plist, stdoutPath, stderrPath }
}

export function installLaunchdAgent(targetUser: string, installDir: string, elevated = false, deps: { findSystemUser: (user: string) => any; targetHomeForUser: (user: string) => string; repoRootFromHere: () => string }) {
  const target = deps.findSystemUser(targetUser) as any
  const uid = Number(target?.uid ?? -1)
  if (uid < 0) throw new Error(`rin_launchd_target_user_not_found:${targetUser}`)
  const { label, plistPath, plist, stdoutPath, stderrPath } = buildLaunchdPlist(targetUser, installDir, deps.targetHomeForUser, deps.repoRootFromHere)
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

export function buildSystemdUserService(targetUser: string, installDir: string, targetHomeForUser: (user: string) => string, repoRootFromHere: () => string) {
  const daemonEntry = resolveDaemonEntryForInstall(installDir, repoRootFromHere)
  const targetHome = targetHomeForUser(targetUser)
  const unitName = `rin-daemon-${String(targetUser).replace(/[^A-Za-z0-9_.@-]+/g, '-')}.service`
  const unitPath = path.join(targetHome, '.config', 'systemd', 'user', unitName)
  const service = `[Unit]\nDescription=Rin daemon for ${targetUser}\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${targetHome}\nEnvironment=RIN_DIR=${installDir}\nExecStart=${process.execPath} ${daemonEntry}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`
  return { kind: 'systemd' as const, label: unitName, servicePath: unitPath, service }
}

export function installSystemdUserService(targetUser: string, installDir: string, elevated = false, deps: { findSystemUser: (user: string) => any; targetHomeForUser: (user: string) => string; repoRootFromHere: () => string }) {
  const target = deps.findSystemUser(targetUser) as any
  const spec = buildSystemdUserService(targetUser, installDir, deps.targetHomeForUser, deps.repoRootFromHere)
  const systemctl = fs.existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : 'systemctl'
  const loginctl = fs.existsSync('/usr/bin/loginctl') ? '/usr/bin/loginctl' : 'loginctl'
  const uid = Number(target?.uid ?? -1)
  const runtimeDir = uid >= 0 ? `/run/user/${uid}` : ''
  const userEnv = runtimeDir && fs.existsSync(runtimeDir) ? { XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` } : {}
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

export function refreshManagedServiceFiles(targetUser: string, installDir: string, elevated = false, deps: { findSystemUser: (user: string) => any; targetHomeForUser: (user: string) => string; repoRootFromHere: () => string }) {
  if (process.platform !== 'linux') return
  const targetHome = deps.targetHomeForUser(targetUser)
  const unitDir = path.join(targetHome, '.config', 'systemd', 'user')
  const unitName = `rin-daemon-${String(targetUser).replace(/[^A-Za-z0-9_.@-]+/g, '-')}.service`
  const candidateFiles = [path.join(unitDir, unitName), path.join(unitDir, 'rin-daemon.service')]
  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath)) continue
    const spec = buildSystemdUserService(targetUser, installDir, deps.targetHomeForUser, deps.repoRootFromHere)
    if (elevated) writeTextFileWithPrivilege(filePath, spec.service, targetUser, deps.findSystemUser(targetUser)?.gid, 0o644)
    else writeTextFile(filePath, spec.service, 0o644)
  }
}

export function systemdUserContext(targetUser: string, deps: { findSystemUser: (user: string) => any }) {
  const systemctl = fs.existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : (fs.existsSync('/bin/systemctl') ? '/bin/systemctl' : '')
  const target = deps.findSystemUser(targetUser) as any
  const uid = Number(target?.uid ?? -1)
  const runtimeDir = uid >= 0 ? `/run/user/${uid}` : ''
  const userEnv = runtimeDir && fs.existsSync(runtimeDir) ? { XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` } : {}
  const unitName = `rin-daemon-${String(targetUser).replace(/[^A-Za-z0-9_.@-]+/g, '-')}.service`
  return { systemctl, userEnv, units: [unitName, 'rin-daemon.service'] }
}

export function captureCommandAsUser(targetUser: string, command: string, args: string[], extraEnv: Record<string, string> = {}) {
  const envArgs = Object.entries(extraEnv).map(([key, value]) => `${key}=${JSON.stringify(value)}`)
  const shellCommand = [...envArgs, JSON.stringify(command), ...args.map((arg) => JSON.stringify(arg))].join(' ')
  const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false
  if (isRoot && fs.existsSync('/usr/sbin/runuser')) return execFileSync('/usr/sbin/runuser', ['-u', targetUser, '--', 'sh', '-lc', shellCommand], { encoding: 'utf8' })
  const privilegeCommand = pickPrivilegeCommand()
  if (privilegeCommand.endsWith('doas') || privilegeCommand.endsWith('sudo')) return execFileSync(privilegeCommand, ['-u', targetUser, 'sh', '-lc', shellCommand], { encoding: 'utf8' })
  return execFileSync(privilegeCommand, ['sh', '-lc', shellCommand], { encoding: 'utf8' })
}

export function daemonSocketPathForUser(targetUser: string, deps: { findSystemUser: (user: string) => any; targetHomeForUser: (user: string) => string }) {
  const target = deps.findSystemUser(targetUser) as any
  if (process.platform === 'darwin') return path.join(deps.targetHomeForUser(targetUser), 'Library', 'Caches', 'rin-daemon', 'daemon.sock')
  const uid = Number(target?.uid ?? -1)
  if (uid >= 0) return path.join('/run/user', String(uid), 'rin-daemon', 'daemon.sock')
  return path.join(deps.targetHomeForUser(targetUser), '.cache', 'rin-daemon', 'daemon.sock')
}

export function collectDaemonFailureDetails(targetUser: string, installDir: string, deps: { findSystemUser: (user: string) => any; targetHomeForUser: (user: string) => string }) {
  const socketPath = daemonSocketPathForUser(targetUser, deps)
  const lines = [`targetUser=${targetUser}`, `installDir=${installDir}`, `socketPath=${socketPath}`, 'socketReady=no']
  if (process.platform === 'linux') {
    const { systemctl, userEnv, units } = systemdUserContext(targetUser, deps)
    const effectiveUser = (() => { try { return os.userInfo().username } catch { return '' } })()
    if (systemctl) {
      for (const unit of units) {
        try {
          const status = targetUser && targetUser !== effectiveUser ? captureCommandAsUser(targetUser, systemctl, ['--user', 'status', unit, '--no-pager', '-l'], userEnv) : execFileSync(systemctl, ['--user', 'status', unit, '--no-pager', '-l'], { encoding: 'utf8', env: { ...process.env, ...userEnv } })
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
      for (const unit of units) {
        try {
          const journal = targetUser && targetUser !== effectiveUser ? captureCommandAsUser(targetUser, 'journalctl', ['--user', '-u', unit, '-n', '20', '--no-pager'], userEnv) : execFileSync('journalctl', ['--user', '-u', unit, '-n', '20', '--no-pager'], { encoding: 'utf8', env: { ...process.env, ...userEnv } })
          if (String(journal || '').trim()) {
            lines.push(`serviceJournal=${unit}`, ...String(journal).trim().split(/\r?\n/).slice(-20))
            break
          }
        } catch {}
      }
    }
  }
  return lines.join('\n')
}

export function reconcileSystemdUserService(targetUser: string, installDir: string, action: 'start' | 'restart', elevated = false, deps: { findSystemUser: (user: string) => any }) {
  void installDir
  if (process.platform !== 'linux') return false
  const { systemctl, userEnv, units } = systemdUserContext(targetUser, deps)
  if (!systemctl) return false
  if (elevated) {
    runCommandAsUser(targetUser, systemctl, ['--user', 'daemon-reload'], userEnv)
    for (const unit of units) {
      try {
        runCommandAsUser(targetUser, systemctl, ['--user', action, unit], userEnv)
        return true
      } catch {}
    }
    return false
  }
  execFileSync(systemctl, ['--user', 'daemon-reload'], { stdio: 'inherit', env: { ...process.env, ...userEnv } })
  for (const unit of units) {
    try {
      execFileSync(systemctl, ['--user', action, unit], { stdio: 'inherit', env: { ...process.env, ...userEnv } })
      return true
    } catch {}
  }
  return false
}

export function installDaemonService(targetUser: string, installDir: string, elevated = false, deps: { findSystemUser: (user: string) => any; targetHomeForUser: (user: string) => string; repoRootFromHere: () => string }) {
  if (process.platform === 'darwin') return installLaunchdAgent(targetUser, installDir, elevated, deps)
  if (process.platform === 'linux' && (fs.existsSync('/usr/bin/systemctl') || fs.existsSync('/bin/systemctl'))) return installSystemdUserService(targetUser, installDir, elevated, deps)
  throw new Error(`rin_service_install_unsupported:${process.platform}`)
}

export async function waitForSocket(socketPath: string, timeoutMs = 5000, targetUser?: string) {
  const startedAt = Date.now()
  const currentUser = (() => { try { return os.userInfo().username } catch { return '' } })()
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      if (targetUser && targetUser !== currentUser) {
        try {
          const probe = captureCommandAsUser(targetUser, process.execPath, ['-e', `const net=require('node:net');const s=net.createConnection(${JSON.stringify(socketPath)});let done=false;const finish=(ok)=>{if(done)return;done=true;try{s.destroy()}catch{};process.exit(ok?0:1)};s.once('connect',()=>finish(true));s.once('error',()=>finish(false));setTimeout(()=>finish(false),300);`])
          void probe
          resolve(true)
          return
        } catch {
          resolve(false)
          return
        }
      }
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
      setTimeout(() => finish(false), 300)
    })
    if (ok) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}
