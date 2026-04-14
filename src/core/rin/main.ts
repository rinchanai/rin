#!/usr/bin/env node
import { cac } from "cac";

import { runStart, runStop, runRestart } from "./control.js";
import { runDoctor } from "./doctor.js";
import { launchDefaultRin } from "./launch.js";
import {
  ParsedArgs,
  resolveParsedArgs,
  runUpdate,
  safeString,
} from "./shared.js";
import { runUsage, runUsageInternal } from "./usage.js";

export function createCli() {
  const cli = cac("rin");
  cli
    .usage("[command] [options] [-- passthrough]")
    .option("-u, --user <name>", "Run against a specific daemon user")
    .option("--std", "Start std TUI instead of RPC TUI")
    .option(
      "-t, --tmux <session>",
      "Create or attach a hidden Rin tmux session",
    )
    .option("--tmux-list", "List hidden Rin tmux sessions")
    .help();

  cli.command(
    "update",
    "Update the installed Rin core runtime for the target user (does not update the CLI launcher)",
  );
  cli.command("start", "Start the target user daemon");
  cli.command("stop", "Stop the target user daemon");
  cli.command("restart", "Restart the target user daemon");
  cli.command("doctor", "Show daemon/socket diagnostics for the target user");
  cli.command(
    "usage",
    "Show token telemetry dashboard and grouped usage stats",
  );

  return cli;
}

export function parseCommandName(name: string): ParsedArgs["command"] {
  return ["update", "start", "stop", "restart", "doctor", "usage"].includes(
    name,
  )
    ? (name as ParsedArgs["command"])
    : "";
}

export async function startRinCli(
  deps: {
    argv?: string[];
    createCli?: typeof createCli;
    runUsageInternal?: typeof runUsageInternal;
    resolveParsedArgs?: typeof resolveParsedArgs;
    safeString?: typeof safeString;
    runUpdate?: typeof runUpdate;
    runStart?: typeof runStart;
    runStop?: typeof runStop;
    runRestart?: typeof runRestart;
    runDoctor?: typeof runDoctor;
    runUsage?: typeof runUsage;
    launchDefaultRin?: typeof launchDefaultRin;
  } = {},
) {
  const argv = deps.argv ?? process.argv;
  const runUsageInternalFn = deps.runUsageInternal ?? runUsageInternal;
  const resolveParsedArgsFn = deps.resolveParsedArgs ?? resolveParsedArgs;
  const safeStringFn = deps.safeString ?? safeString;
  const runUpdateFn = deps.runUpdate ?? runUpdate;
  const runStartFn = deps.runStart ?? runStart;
  const runStopFn = deps.runStop ?? runStop;
  const runRestartFn = deps.runRestart ?? runRestart;
  const runDoctorFn = deps.runDoctor ?? runDoctor;
  const runUsageFn = deps.runUsage ?? runUsage;
  const launchDefaultRinFn = deps.launchDefaultRin ?? launchDefaultRin;

  if (argv[2] === "__usage_internal") {
    await runUsageInternalFn(argv.slice(3));
    return;
  }
  if (
    argv[2] === "usage" &&
    argv.slice(3).some((arg) => arg === "--help" || arg === "-h")
  ) {
    await runUsageInternalFn(["--help"]);
    return;
  }

  const cli = (deps.createCli ?? createCli)();
  const parsedArgv = cli.parse(argv, { run: false });
  if (parsedArgv.options.help) {
    cli.outputHelp();
    return;
  }

  const command = parseCommandName(safeStringFn(cli.matchedCommandName).trim());
  const parsed = resolveParsedArgsFn(
    command,
    parsedArgv.options,
    argv.slice(2),
  );

  if (parsed.command === "update") return await runUpdateFn(parsed);
  if (parsed.command === "start") return await runStartFn(parsed);
  if (parsed.command === "stop") return await runStopFn(parsed);
  if (parsed.command === "restart") return await runRestartFn(parsed);
  if (parsed.command === "doctor") return await runDoctorFn(parsed);
  if (parsed.command === "usage")
    return await runUsageFn(parsed, argv.slice(2));

  await launchDefaultRinFn(parsed);
}
