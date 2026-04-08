import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { isTmuxNoServerError, socketPathForUser } from "../rin-lib/system.js";
import { bridgeDaemonSocketPath } from "../rin-lib/common.js";
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

export function isStaleTmuxSessionProcess(
  cmdline: string,
  expectedEntryRealpath: string,
) {
  if (!cmdline.includes("rin-tui/main.js")) return false;
  return !cmdline.includes(expectedEntryRealpath);
}

async function restartTmuxSessionIfStale(
  socketArgs: string[],
  sessionName: string,
  expectedEntry: string,
  env: Record<string, string>,
  cwd: string,
) {
  const expectedEntryRealpath = fs.realpathSync.native(expectedEntry);
  const panes = await runCommandCapture(
    "tmux",
    [...socketArgs, "list-panes", "-t", sessionName, "-F", "#{pane_pid}"],
    { env, cwd },
  ).catch(() => null);
  if (!panes || panes.code !== 0) return;

  const panePids = panes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const pid of panePids) {
    let cmdline = "";
    try {
      cmdline = fs
        .readFileSync(`/proc/${pid}/cmdline`)
        .toString("utf8")
        .replace(/\u0000/g, " ");
    } catch {
      continue;
    }
    if (!isStaleTmuxSessionProcess(cmdline, expectedEntryRealpath)) continue;
    await runCommandCapture("tmux", [...socketArgs, "kill-session", "-t", sessionName], {
      env,
      cwd,
    }).catch(() => {});
    return;
  }
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

  const daemonSocketPath =
    currentUser === targetUser || !parsed.installDir
      ? socketPathForUser(targetUser)
      : bridgeDaemonSocketPath(parsed.installDir);

  const runtimeEnv = {
    ...(parsed.installDir
      ? {
          [RIN_DIR_ENV]: parsed.installDir,
          [PI_AGENT_DIR_ENV]: parsed.installDir,
        }
      : {}),
    RIN_DAEMON_SOCKET_PATH: daemonSocketPath,
    RIN_INVOKING_SYSTEM_USER: currentUser,
  };

  if (parsed.tmuxList) {
    const result = await runCommandCapture(
      "tmux",
      buildTmuxListArgs(tmuxSocketArgs).slice(1),
      {
        env: { ...process.env, ...runtimeEnv },
        cwd: repoRoot,
      },
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
    const commandEnv = { ...process.env, ...runtimeEnv };
    await restartTmuxSessionIfStale(
      tmuxSocketArgs,
      parsed.tmuxSession,
      tuiEntry,
      commandEnv as Record<string, string>,
      repoRoot,
    );
    const tmuxCommand = [
      "env",
      ...Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`),
      process.execPath,
      tuiEntry,
      parsed.std ? "--std" : "--rpc",
      ...parsed.passthrough,
    ];
    const code = await runCommand(
      "tmux",
      [
        ...tmuxSocketArgs,
        "new-session",
        "-A",
        "-s",
        parsed.tmuxSession,
        ...tmuxCommand,
      ],
      {
        env: commandEnv,
        cwd: repoRoot,
      },
    );
    process.exit(code);
  }

  const code = await runCommand(
    process.execPath,
    [
      path.join(repoRoot, "dist", "app", "rin-tui", "main.js"),
      parsed.std ? "--std" : "--rpc",
      ...parsed.passthrough,
    ],
    {
      env: { ...process.env, ...runtimeEnv },
      cwd: repoRoot,
    },
  );
  process.exit(code);
}
