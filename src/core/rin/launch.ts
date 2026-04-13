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

export async function launchDefaultRin(
  parsed: ParsedArgs,
  deps: {
    repoRootFromHere?: typeof repoRootFromHere;
    runTargetCommandCapture?: typeof runTargetCommandCapture;
    runTargetCommand?: typeof runTargetCommand;
    buildTuiRuntimeEnv?: typeof buildTuiRuntimeEnv;
    currentUser?: string;
    stdoutWrite?: (text: string) => void;
    stderrWrite?: (text: string) => void;
    exit?: (code: number) => never | void;
  } = {},
) {
  const repoRoot = (deps.repoRootFromHere ?? repoRootFromHere)();
  const targetUser = parsed.targetUser;
  const currentUser = deps.currentUser ?? os.userInfo().username;
  const targetCommandCapture =
    deps.runTargetCommandCapture ?? runTargetCommandCapture;
  const targetCommand = deps.runTargetCommand ?? runTargetCommand;
  const buildRuntimeEnv = deps.buildTuiRuntimeEnv ?? buildTuiRuntimeEnv;
  const stdoutWrite =
    deps.stdoutWrite ?? ((text: string) => process.stdout.write(text));
  const stderrWrite =
    deps.stderrWrite ?? ((text: string) => process.stderr.write(text));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const tmuxSocketArgs = buildTmuxSocketArgs(targetUser);

  if (!parsed.explicitUser && !parsed.hasSavedInstall) {
    throw new Error(
      `rin_not_installed: run rin-install first or pass --user/-u explicitly (expected ${installConfigPath()})`,
    );
  }
  if (parsed.tmuxSession && parsed.tmuxList)
    throw new Error("rin_tmux_mode_conflict");

  const runtimeEnv = buildRuntimeEnv(
    targetUser,
    currentUser,
    parsed.installDir,
  );

  if (parsed.tmuxList) {
    const commandEnv = runtimeEnv;
    const result = await targetCommandCapture(
      targetUser,
      buildTmuxListArgs(tmuxSocketArgs),
      commandEnv as Record<string, string>,
      repoRoot,
    );
    if (result.stdout) stdoutWrite(result.stdout);
    if (!isTmuxNoServerError(result.code, result.stderr) && result.stderr) {
      stderrWrite(result.stderr);
    }
    exit(isTmuxNoServerError(result.code, result.stderr) ? 0 : result.code);
    return;
  }

  if (parsed.tmuxSession) {
    const tuiEntry = path.join(repoRoot, "dist", "app", "rin-tui", "main.js");
    const commandEnv = runtimeEnv;
    const code = await targetCommand(
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
    exit(code);
    return;
  }

  const code = await targetCommand(
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
  exit(code);
}
