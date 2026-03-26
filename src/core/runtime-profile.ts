import os from 'node:os'
import path from 'node:path'

export const RIN_DIR_ENV = 'RIN_DIR'

export function resolveRuntimeProfile(options: { cwd?: string; agentDir?: string } = {}) {
  const cwd = options.cwd || os.homedir()
  const agentDir = options.agentDir || process.env[RIN_DIR_ENV]?.trim() || path.join(os.homedir(), '.rin')
  return { cwd, agentDir }
}
