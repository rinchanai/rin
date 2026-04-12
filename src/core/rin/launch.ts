import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  buildUserShell,
  isTmuxNoServerError,
  socketPathForUser,
  targetUserRuntimeEnv,
} from "../rin-lib/system.js";
import { PI_AGENT_DIR_ENV, RIN_DIR_ENV } from "../rin-lib/runtime.js";

import {
  createTargetExecutionContext,
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

export function buildTmuxSocketArgs(targetUser: string) {
  return ["-L", `rin-${targetUser}`];
}

export function buildTmuxListArgs(socketArgs: string[]) {
  return ["tmux", ...socketArgs, "list-sessions", "-F", "#S"];
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

export async function launchDefaultRin(parsed: ParsedArgs) {
  const repoRoot = repoRootFromHere();
  const targetUser = parsed.targetUser;
  const currentUser = os.userInfo().username;
  const tmuxSocketArgs = buildTmuxSocketArgs(targetUser);

  if (!parsed.explicitUser && !parsed.hasSavedInstall) {
    throw new Error(
      `rin_not_installed: run rin-install first or pass --user/-u explicitly (expected ${installConfigPath()})`,
    );
  }
  if (parsed.tmuxSession && parsed.tmuxList)
    throw new Error("rin_tmux_mode_conflict");

  const runtimeEnv = buildTuiRuntimeEnv(
    targetUser,
    currentUser,
    parsed.installDir,
  );

  if (parsed.tmuxList) {
    const commandEnv = runtimeEnv;
    const result = await runTargetCommandCapture(
      targetUser,
      buildTmuxListArgs(tmuxSocketArgs),
      commandEnv as Record<string, string>,
      repoRoot,
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (!isTmuxNoServerError(result.code, result.stderr) && result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exit(
      isTmuxNoServerError(result.code, result.stderr) ? 0 : result.code,
    );
  }

  if (parsed.tmuxSession) {
    const tuiEntry = path.join(repoRoot, "dist", "app", "rin-tui", "main.js");
    const commandEnv = runtimeEnv;
    const code = await runTargetCommand(
      targetUser,
      [
        "tmux",
        ...tmuxSocketArgs,
        "new-session",
        "-A",
        "-s",
        parsed.tmuxSession,
        process.execPath,
        tuiEntry,
        parsed.std ? "--std" : "--rpc",
        ...parsed.passthrough,
      ],
      commandEnv as Record<string, string>,
      repoRoot,
    );
    process.exit(code);
  }

  const code = await runTargetCommand(
    targetUser,
    [
      process.execPath,
      path.join(repoRoot, "dist", "app", "rin-tui", "main.js"),
      parsed.std ? "--std" : "--rpc",
      ...parsed.passthrough,
    ],
    runtimeEnv,
    repoRoot,
  );
  process.exit(code);
}
