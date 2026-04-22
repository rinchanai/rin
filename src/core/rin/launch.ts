import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  buildUserShell,
  socketPathForUser,
  targetUserRuntimeEnv,
} from "../rin-lib/system.js";
import { PI_AGENT_DIR_ENV, RIN_DIR_ENV } from "../rin-lib/runtime.js";

import {
  installConfigPath,
  ParsedArgs,
  repoRootFromHere,
  runCommand,
} from "./shared.js";

async function runCommandCapture(
  command: string,
  args: string[],
  options: any = {},
) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, { ...options, stdio: "pipe" });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) return reject(new Error(`terminated:${signal}`));
        resolve({ code: code ?? 0, stdout, stderr });
      });
    },
  );
}

export function buildHiddenSessionListArgs(repoRoot: string) {
  return [
    process.execPath,
    path.join(repoRoot, "dist", "app", "rin-hidden-session", "main.js"),
    "list",
  ];
}

export function buildTuiModeArg(std: boolean) {
  return std ? "--std" : "--rpc";
}

export function buildTuiRuntimeEnv(
  targetUser: string,
  currentUser: string,
  installDir?: string,
) {
  return targetUserRuntimeEnv(targetUser, {
    ...(installDir
      ? {
          [RIN_DIR_ENV]: installDir,
          [PI_AGENT_DIR_ENV]: installDir,
        }
      : {}),
    RIN_DAEMON_SOCKET_PATH: socketPathForUser(targetUser),
    RIN_INVOKING_SYSTEM_USER: currentUser,
  });
}

export function buildDirectTuiArgs(
  tuiEntry: string,
  options: { std: boolean; passthrough: string[] },
) {
  return [
    process.execPath,
    tuiEntry,
    buildTuiModeArg(options.std),
    ...options.passthrough,
  ];
}

export function buildHiddenSessionAttachArgs(
  repoRoot: string,
  sessionName: string,
  std: boolean,
  passthrough: string[],
) {
  return [
    process.execPath,
    path.join(repoRoot, "dist", "app", "rin-hidden-session", "main.js"),
    "attach",
    sessionName,
    buildTuiModeArg(std),
    "--",
    ...passthrough,
  ];
}

async function runTargetCommandCapture(
  targetUser: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
) {
  const launch = buildUserShell(targetUser, argv, env);
  return await runCommandCapture(launch.command, launch.args, {
    env: launch.env,
    cwd,
  });
}

async function runTargetCommand(
  targetUser: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
) {
  const launch = buildUserShell(targetUser, argv, env);
  return await runCommand(launch.command, launch.args, {
    env: launch.env,
    cwd,
  });
}

function resolveLaunchContext(parsed: ParsedArgs) {
  const repoRoot = repoRootFromHere();
  const targetUser = parsed.targetUser;
  const currentUser = os.userInfo().username;
  const runtimeEnv = buildTuiRuntimeEnv(
    targetUser,
    currentUser,
    parsed.installDir,
  );
  const tuiEntry = path.join(repoRoot, "dist", "app", "rin-tui", "main.js");
  const tuiArgv = buildDirectTuiArgs(tuiEntry, {
    std: parsed.std,
    passthrough: parsed.passthrough,
  });
  return {
    repoRoot,
    targetUser,
    runtimeEnv,
    tuiArgv,
  };
}

export async function launchDefaultRin(parsed: ParsedArgs) {
  if (!parsed.explicitUser && !parsed.hasSavedInstall) {
    throw new Error(
      `rin_not_installed: run rin-install first or pass --user/-u explicitly (expected ${installConfigPath()})`,
    );
  }
  if (parsed.hiddenSessionName && parsed.hiddenSessionList)
    throw new Error("rin_hidden_session_mode_conflict");

  const { repoRoot, targetUser, runtimeEnv, tuiArgv } = resolveLaunchContext(parsed);

  if (parsed.hiddenSessionList) {
    const result = await runTargetCommandCapture(
      targetUser,
      buildHiddenSessionListArgs(repoRoot),
      runtimeEnv as Record<string, string>,
      repoRoot,
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.code);
  }

  const argv = parsed.hiddenSessionName
    ? buildHiddenSessionAttachArgs(
        repoRoot,
        parsed.hiddenSessionName,
        parsed.std,
        parsed.passthrough,
      )
    : tuiArgv;
  const code = await runTargetCommand(
    targetUser,
    argv,
    runtimeEnv as Record<string, string>,
    repoRoot,
  );
  process.exit(code);
}
