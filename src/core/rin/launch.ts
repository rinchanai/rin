import path from 'node:path'

import { buildUserShell } from '../rin-lib/system.js'
import { PI_AGENT_DIR_ENV, RIN_DIR_ENV } from '../rin-lib/runtime.js'

import { installConfigPath, ParsedArgs, repoRootFromHere, runCommand } from './shared.js'

export async function launchDefaultRin(parsed: ParsedArgs) {
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
