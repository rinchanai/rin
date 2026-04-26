import os from "node:os";
import path from "node:path";
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

export function buildTuiModeArg(std: boolean) {
  return std ? "--std" : "--rpc";
}

export function buildTuiRuntimeEnv(
  targetUser: string,
  currentUser: string,
  installDir?: string,
) {
  const runtimeAgentDir =
    String(process.env[RIN_DIR_ENV] || "").trim() ||
    String(process.env[PI_AGENT_DIR_ENV] || "").trim() ||
    String(installDir || "").trim();
  return targetUserRuntimeEnv(targetUser, {
    ...(runtimeAgentDir
      ? {
          [RIN_DIR_ENV]: runtimeAgentDir,
          [PI_AGENT_DIR_ENV]: runtimeAgentDir,
        }
      : {}),
    RIN_DAEMON_SOCKET_PATH: socketPathForUser(targetUser),
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
  const { repoRoot, targetUser, runtimeEnv, tuiArgv } =
    resolveLaunchContext(parsed);

  const code = await runTargetCommand(
    targetUser,
    tuiArgv,
    runtimeEnv as Record<string, string>,
    repoRoot,
  );
  process.exit(code);
}
