import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { spinner } from "@clack/prompts";

import { createInstallerI18n, type InstallerI18n } from "./i18n.js";

import { type InstalledReleaseInfo } from "../rin-lib/release.js";

export type FinalizeInstallOptions = {
  currentUser: string;
  targetUser: string;
  installDir: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  language?: string;
  chatDescription?: string;
  chatDetail?: string;
  chatConfig?: any;
  authData?: any;
  sourceRoot?: string;
  release?: InstalledReleaseInfo;
};

export async function runFinalizeInstallPlanInChild(
  options: FinalizeInstallOptions,
  message: string,
  deps: {
    ensureNotCancelled: <T>(value: T | symbol) => T;
    i18n?: InstallerI18n;
  },
) {
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-install-"));
  const resultPath = path.join(resultDir, "result.json");
  const errorPath = path.join(resultDir, "error.txt");
  const i18n = deps.i18n || createInstallerI18n(options.language || "en");
  try {
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
        if (signal)
          reject(new Error(`rin_installer_child_terminated:${signal}`));
        else resolve(code ?? 1);
      });
    }).catch((error) => {
      waitSpinner.stop(i18n.installStepFailed);
      throw error;
    });

    if (exitCode !== 0) {
      waitSpinner.stop(i18n.installStepFailed);
      let errorMessage = "rin_installer_apply_failed";
      try {
        errorMessage = fs.readFileSync(errorPath, "utf8").trim() || errorMessage;
      } catch {}
      throw new Error(errorMessage);
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    } catch {
      waitSpinner.stop(i18n.installStepFailed);
      throw new Error("rin_installer_apply_result_missing");
    }

    waitSpinner.stop(i18n.installStepComplete);
    return parsed;
  } finally {
    try {
      fs.rmSync(resultDir, { recursive: true, force: true });
    } catch {}
  }
}
