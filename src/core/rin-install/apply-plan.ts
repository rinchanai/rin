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
  },
) {
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-install-"));
  const resultPath = path.join(resultDir, "result.json");
  const errorPath = path.join(resultDir, "error.txt");
  const child = spawn(
    process.execPath,
    [process.argv[1] || fileURLToPath(import.meta.url)],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        RIN_INSTALL_APPLY_PLAN: JSON.stringify(options),
        RIN_INSTALL_APPLY_RESULT: resultPath,
        RIN_INSTALL_APPLY_ERROR: errorPath,
      },
    },
  );

  const waitSpinner = spinner();
  waitSpinner.start(message);

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`rin_installer_child_terminated:${signal}`));
      else resolve(code ?? 1);
    });
  }).catch((error) => {
    waitSpinner.stop("Install step failed.");
    throw error;
  });

  try {
    const parsed = readFinalizeInstallChildResult(
      resultPath,
      errorPath,
      exitCode,
    );
    waitSpinner.stop("Install step complete.");
    return parsed;
  } catch (error) {
    waitSpinner.stop("Install step failed.");
    throw error;
  } finally {
    try {
      fs.rmSync(resultDir, { recursive: true, force: true });
    } catch {}
  }
}
