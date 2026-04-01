import fs from 'node:fs'
import path from 'node:path'

import { listInstanceIds as listSidecarInstanceIds, readInstanceState as readSidecarInstanceState, writeInstanceState as writeSidecarInstanceState } from '../sidecar/common.js'
import { readJsonFile, writeJsonAtomic } from '../platform/fs.js'

export function dataRootForState(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), 'data', 'web-search')
}
export function runtimeRootForState(stateRoot: string): string { return path.join(dataRootForState(stateRoot), 'runtime') }
export function instancesRootForState(stateRoot: string): string { return path.join(dataRootForState(stateRoot), 'instances') }
export function runtimeLockPathForState(stateRoot: string): string { return path.join(runtimeRootForState(stateRoot), 'install.lock') }
export function runtimeSourceDirForState(stateRoot: string): string { return path.join(runtimeRootForState(stateRoot), 'src') }
export function runtimeVenvDirForState(stateRoot: string): string { return path.join(runtimeRootForState(stateRoot), 'venv') }
export function runtimeTmpDirForState(stateRoot: string): string { return path.join(runtimeRootForState(stateRoot), 'tmp') }
export function runtimeBootstrapStateFileForState(stateRoot: string): string { return path.join(runtimeRootForState(stateRoot), 'bootstrap.json') }
export function runtimePythonBinForState(stateRoot: string): string {
  const dir = runtimeVenvDirForState(stateRoot)
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python')
}
export function runtimePipBinForState(stateRoot: string): string {
  const dir = runtimeVenvDirForState(stateRoot)
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'pip.exe') : path.join(dir, 'bin', 'pip')
}
export function instanceRootForState(stateRoot: string, instanceId: string): string { return path.join(instancesRootForState(stateRoot), instanceId) }
export function instanceStateFileForState(stateRoot: string, instanceId: string): string { return path.join(instanceRootForState(stateRoot, instanceId), 'state.json') }
export function instanceSettingsFileForState(stateRoot: string, instanceId: string): string { return path.join(instanceRootForState(stateRoot, instanceId), 'settings.yml') }
export function readRuntimeBootstrapState(stateRoot: string) { return readJsonFile<any>(runtimeBootstrapStateFileForState(stateRoot), null) }
export function writeRuntimeBootstrapState(stateRoot: string, value: any) { writeJsonAtomic(runtimeBootstrapStateFileForState(stateRoot), value) }
export function readInstanceState(stateRoot: string, instanceId: string) { return readSidecarInstanceState<any>(instanceStateFileForState(stateRoot, instanceId)) }
export function listInstanceIds(stateRoot: string) { return listSidecarInstanceIds(instancesRootForState(stateRoot)) }
export function writeInstanceState(stateRoot: string, instanceId: string, value: any) { writeSidecarInstanceState(instanceStateFileForState(stateRoot, instanceId), value) }
export function removeInstanceState(stateRoot: string, instanceId: string) { try { fs.rmSync(instanceStateFileForState(stateRoot, instanceId), { force: true }) } catch {} }
