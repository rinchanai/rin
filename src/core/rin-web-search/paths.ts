import fs from "node:fs";
import path from "node:path";

import {
  listInstanceIds as listSidecarInstanceIds,
  readInstanceState as readSidecarInstanceState,
  writeInstanceState as writeSidecarInstanceState,
} from "../sidecar/common.js";
import { readJsonFile, writeJsonAtomic } from "../platform/fs.js";

export type RuntimeBootstrapState = {
  ready?: boolean;
  sourceDir?: string;
  pythonBin?: string;
  pipBin?: string;
  installedAt?: string;
};

export type WebSearchInstanceState = {
  pid?: number;
  port?: number;
  baseUrl?: string;
  pythonBin?: string;
  sourceDir?: string;
  settingsPath?: string;
  startedAt?: string;
  ownerPid?: number;
};

export function dataRootForState(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), "data", "web-search");
}

export function runtimeRootForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), "runtime");
}

export function instancesRootForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), "instances");
}

export function runtimeLockPathForState(stateRoot: string): string {
  return path.join(runtimeRootForState(stateRoot), "install.lock");
}

export function runtimeSourceDirForState(stateRoot: string): string {
  return path.join(runtimeRootForState(stateRoot), "src");
}

export function runtimeVenvDirForState(stateRoot: string): string {
  return path.join(runtimeRootForState(stateRoot), "venv");
}

export function runtimeTmpDirForState(stateRoot: string): string {
  return path.join(runtimeRootForState(stateRoot), "tmp");
}

export function runtimeBootstrapStateFileForState(stateRoot: string): string {
  return path.join(runtimeRootForState(stateRoot), "bootstrap.json");
}

export function runtimePythonBinForState(stateRoot: string): string {
  const dir = runtimeVenvDirForState(stateRoot);
  return process.platform === "win32"
    ? path.join(dir, "Scripts", "python.exe")
    : path.join(dir, "bin", "python");
}

export function runtimePipBinForState(stateRoot: string): string {
  const dir = runtimeVenvDirForState(stateRoot);
  return process.platform === "win32"
    ? path.join(dir, "Scripts", "pip.exe")
    : path.join(dir, "bin", "pip");
}

export function instanceRootForState(
  stateRoot: string,
  instanceId: string,
): string {
  return path.join(instancesRootForState(stateRoot), instanceId);
}

export function instanceStateFileForState(
  stateRoot: string,
  instanceId: string,
): string {
  return path.join(instanceRootForState(stateRoot, instanceId), "state.json");
}

export function instanceSettingsFileForState(
  stateRoot: string,
  instanceId: string,
): string {
  return path.join(instanceRootForState(stateRoot, instanceId), "settings.yml");
}

export function readRuntimeBootstrapState(
  stateRoot: string,
): RuntimeBootstrapState | null {
  return readJsonFile<RuntimeBootstrapState | null>(
    runtimeBootstrapStateFileForState(stateRoot),
    null,
  );
}

export function writeRuntimeBootstrapState(
  stateRoot: string,
  value: RuntimeBootstrapState,
): void {
  writeJsonAtomic(runtimeBootstrapStateFileForState(stateRoot), value);
}

export function readInstanceState(
  stateRoot: string,
  instanceId: string,
): WebSearchInstanceState | null {
  return readSidecarInstanceState<WebSearchInstanceState | null>(
    instanceStateFileForState(stateRoot, instanceId),
  );
}

export function listInstanceIds(stateRoot: string): string[] {
  return listSidecarInstanceIds(instancesRootForState(stateRoot));
}

export function writeInstanceState(
  stateRoot: string,
  instanceId: string,
  value: WebSearchInstanceState,
): void {
  writeSidecarInstanceState(instanceStateFileForState(stateRoot, instanceId), value);
}

export function removeInstanceRoot(stateRoot: string, instanceId: string): void {
  try {
    fs.rmSync(instanceRootForState(stateRoot, instanceId), {
      recursive: true,
      force: true,
    });
  } catch {}
}

export function removeInstanceState(stateRoot: string, instanceId: string): void {
  removeInstanceRoot(stateRoot, instanceId);
}
