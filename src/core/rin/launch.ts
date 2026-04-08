import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { buildUserShell, isTmuxNoServerError } from "../rin-lib/system.js";
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

export function buildTmuxListArgs(socketName: string) {
  return ["tmux", "-L", socketName, "list-sessions", "-F", "#S"];
}

export async function launchDefaultRin(parsed: ParsedArgs) {
  const repoRoot = repoRootFromHere();
  const targetUser = parsed.targetUser;
  const tmuxSocketName = `rin-${targetUser}`;

  if (!parsed.explicitUser && !parsed.hasSavedInstall) {
    throw new Error(
      `rin_not_installed: run rin-install first or pass --user/-u explicitly (expected ${installConfigPath()})`,
    );
  }
  if (parsed.tmuxSession && parsed.tmuxList)
    throw new Error("rin_tmux_mode_conflict");

  if (!parsed.std) {
    const context = createTargetExecutionContext(parsed);
    if (!(await context.canConnectSocket())) {
      const userSuffix = parsed.explicitUser ? ` -u ${targetUser}` : "";
      throw new Error(
        [
          `rin_rpc_unavailable: daemon socket is not reachable for ${targetUser}`,
          `try: rin doctor${userSuffix}`,
          `if RPC mode is still broken, try: rin --std${userSuffix}`,
        ].join("\n"),
      );
    }
  }

  const runtimeEnv = {
    ...(parsed.installDir
      ? {
          [RIN_DIR_ENV]: parsed.installDir,
          [PI_AGENT_DIR_ENV]: parsed.installDir,
        }
      : {}),
    RIN_INVOKING_SYSTEM_USER: os.userInfo().username,
  };

  if (parsed.tmuxList) {
    const launch = buildUserShell(
      targetUser,
      buildTmuxListArgs(tmuxSocketName),
      runtimeEnv,
    );
    const result = await runCommandCapture(launch.command, launch.args, {
      env: launch.env,
      cwd: repoRoot,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (!isTmuxNoServerError(result.code, result.stderr) && result.stderr)
      process.stderr.write(result.stderr);
    process.exit(
      isTmuxNoServerError(result.code, result.stderr) ? 0 : result.code,
    );
  }

  if (parsed.tmuxSession) {
    const innerArgs = [
      process.execPath,
      path.join(repoRoot, "dist", "app", "rin-tui", "main.js"),
      parsed.std ? "--std" : "--rpc",
      ...parsed.passthrough,
    ];
    const innerLaunch = buildUserShell(targetUser, innerArgs, runtimeEnv);
    const code = await runCommand(
      "tmux",
      [
        "-L",
        tmuxSocketName,
        "new-session",
        "-A",
        "-s",
        parsed.tmuxSession,
        innerLaunch.command,
        ...innerLaunch.args,
      ],
      {
        env: innerLaunch.env,
        cwd: repoRoot,
      },
    );
    process.exit(code);
  }

  const launch = buildUserShell(
    targetUser,
    [
      process.execPath,
      path.join(repoRoot, "dist", "app", "rin-tui", "main.js"),
      parsed.std ? "--std" : "--rpc",
      ...parsed.passthrough,
    ],
    runtimeEnv,
  );
  const code = await runCommand(launch.command, launch.args, {
    env: launch.env,
    cwd: repoRoot,
  });
  process.exit(code);
}
