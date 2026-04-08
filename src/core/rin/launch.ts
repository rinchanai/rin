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

export function tmuxSocketArgsForInstall(
  installDir: string,
  targetUser: string,
) {
  if (installDir)
    return ["-S", path.join(installDir, "data", "tmux", "server.sock")];
  return ["-L", `rin-${targetUser}`];
}

export function buildTmuxListArgs(socketArgs: string[]) {
  return ["tmux", ...socketArgs, "list-sessions", "-F", "#S"];
}

async function ensureTmuxSocketDir(
  targetUser: string,
  runtimeEnv: Record<string, string>,
  socketArgs: string[],
  cwd: string,
) {
  if (socketArgs[0] !== "-S" || !socketArgs[1]) return;
  const launch = buildUserShell(
    targetUser,
    ["mkdir", "-p", path.dirname(socketArgs[1])],
    runtimeEnv,
  );
  const result = await runCommandCapture(launch.command, launch.args, {
    env: launch.env,
    cwd,
  });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "rin_tmux_socket_dir_create_failed",
    );
  }
}

async function listTmuxSessions(
  targetUser: string,
  runtimeEnv: Record<string, string>,
  socketArgs: string[],
  cwd: string,
  asTargetUser: boolean,
) {
  const launch = asTargetUser
    ? buildUserShell(targetUser, buildTmuxListArgs(socketArgs), runtimeEnv)
    : {
        command: "tmux",
        args: [...socketArgs, "list-sessions", "-F", "#S"],
        env: { ...process.env, ...runtimeEnv },
      };
  const result = await runCommandCapture(launch.command, launch.args, {
    env: launch.env,
    cwd,
  });
  if (!isTmuxNoServerError(result.code, result.stderr) && result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function launchDefaultRin(parsed: ParsedArgs) {
  const repoRoot = repoRootFromHere();
  const targetUser = parsed.targetUser;
  const tmuxSocketArgs = tmuxSocketArgsForInstall(
    parsed.installDir,
    targetUser,
  );

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
    await ensureTmuxSocketDir(targetUser, runtimeEnv, tmuxSocketArgs, repoRoot);
    const names = new Set(
      await listTmuxSessions(
        targetUser,
        runtimeEnv,
        tmuxSocketArgs,
        repoRoot,
        true,
      ),
    );
    const legacySocketArgs = ["-L", `rin-${targetUser}`];
    if (parsed.installDir && os.userInfo().username !== targetUser) {
      for (const name of await listTmuxSessions(
        targetUser,
        runtimeEnv,
        legacySocketArgs,
        repoRoot,
        false,
      )) {
        names.add(name);
      }
    }
    if (names.size) process.stdout.write(`${[...names].join("\n")}\n`);
    process.exit(0);
  }

  if (parsed.tmuxSession) {
    await ensureTmuxSocketDir(targetUser, runtimeEnv, tmuxSocketArgs, repoRoot);
    const innerArgs = [
      process.execPath,
      path.join(repoRoot, "dist", "app", "rin-tui", "main.js"),
      parsed.std ? "--std" : "--rpc",
      ...parsed.passthrough,
    ];
    const innerLaunch = buildUserShell(targetUser, innerArgs, runtimeEnv);
    const tmuxLaunch = buildUserShell(
      targetUser,
      [
        "tmux",
        ...tmuxSocketArgs,
        "new-session",
        "-A",
        "-s",
        parsed.tmuxSession,
        innerLaunch.command,
        ...innerLaunch.args,
      ],
      runtimeEnv,
    );
    const code = await runCommand(tmuxLaunch.command, tmuxLaunch.args, {
      env: tmuxLaunch.env,
      cwd: repoRoot,
    });
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
