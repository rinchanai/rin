import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { isCancel, note, spinner } from "@clack/prompts";

export type FinalizeInstallOptions = {
  currentUser: string;
  targetUser: string;
  installDir: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  koishiDescription?: string;
  koishiDetail?: string;
  koishiConfig?: any;
  authData?: any;
  sourceRoot?: string;
};

export function readFinalizeInstallChildResult(
  resultPath: string,
  errorPath: string,
  exitCode: number,
) {
  if (exitCode !== 0) {
    let errorMessage = "rin_installer_apply_failed";
    try {
      errorMessage = fs.readFileSync(errorPath, "utf8").trim() || errorMessage;
    } catch {}
    throw new Error(errorMessage);
  }

  try {
    return JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch {
    throw new Error("rin_installer_apply_result_missing");
  }
}

export async function runFinalizeInstallPlanInChild(
  options: FinalizeInstallOptions,
  message: string,
  deps: {
    ensureNotCancelled: <T>(value: T | symbol) => T;
    mkdtempSync?: typeof fs.mkdtempSync;
    rmSync?: typeof fs.rmSync;
    spawn?: typeof spawn;
    spinner?: typeof spinner;
    readFinalizeInstallChildResult?: typeof readFinalizeInstallChildResult;
    processExecPath?: string;
    processArgv1?: string;
    processEnv?: NodeJS.ProcessEnv;
    importMetaUrl?: string;
  },
) {
  const mkdtempSyncImpl = deps.mkdtempSync ?? fs.mkdtempSync;
  const rmSyncImpl = deps.rmSync ?? fs.rmSync;
  const spawnImpl = deps.spawn ?? spawn;
  const spinnerFactory = deps.spinner ?? spinner;
  const readChildResult =
    deps.readFinalizeInstallChildResult ?? readFinalizeInstallChildResult;
  const processExecPath = deps.processExecPath ?? process.execPath;
  const processArgv1 = deps.processArgv1 ?? process.argv[1];
  const processEnv = deps.processEnv ?? process.env;
  const importMetaUrl = deps.importMetaUrl ?? import.meta.url;

  const resultDir = mkdtempSyncImpl(path.join(os.tmpdir(), "rin-install-"));
  const resultPath = path.join(resultDir, "result.json");
  const errorPath = path.join(resultDir, "error.txt");
  const child = spawnImpl(
    processExecPath,
    [processArgv1 || fileURLToPath(importMetaUrl)],
    {
      stdio: "ignore",
      env: {
        ...processEnv,
        RIN_INSTALL_APPLY_PLAN: JSON.stringify(options),
        RIN_INSTALL_APPLY_RESULT: resultPath,
        RIN_INSTALL_APPLY_ERROR: errorPath,
      },
    },
  );

  const waitSpinner = spinnerFactory();
  waitSpinner.start(message);

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal)
          reject(new Error(`rin_installer_child_terminated:${signal}`));
        else resolve(code ?? 1);
      });
    }).catch((error) => {
      waitSpinner.stop("Install step failed.");
      throw error;
    });

    try {
      const parsed = readChildResult(resultPath, errorPath, exitCode);
      waitSpinner.stop("Install step complete.");
      return parsed;
    } catch (error) {
      waitSpinner.stop("Install step failed.");
      throw error;
    }
  } finally {
    try {
      rmSyncImpl(resultDir, { recursive: true, force: true });
    } catch {}
  }
}
