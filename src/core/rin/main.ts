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

function createCli() {
  const cli = cac("rin");
  cli
    .usage("[command] [options] [-- passthrough]")
    .option("-u, --user <name>", "Run against a specific daemon user")
    .option("--std", "Start std TUI instead of RPC TUI")
    .option(
      "-t, --tmux <session>",
      "Create or attach a hidden Rin tmux session",
    )
    .option("--tmux-list", "List hidden Rin tmux windows")
    .help();

  cli.command(
    "update",
    "Update the installed Rin core runtime for the target user (does not update the CLI launcher)",
  );
  cli.command("start", "Start the target user daemon");
  cli.command("stop", "Stop the target user daemon");
  cli.command("restart", "Restart the target user daemon");
  cli.command("doctor", "Show daemon/socket diagnostics for the target user");

  return cli;
}

function parseCommandName(name: string): ParsedArgs["command"] {
  return ["update", "start", "stop", "restart", "doctor"].includes(name)
    ? (name as ParsedArgs["command"])
    : "";
}

export async function startRinCli() {
  const cli = createCli();
  const parsedArgv = cli.parse(process.argv, { run: false });
  if (parsedArgv.options.help) {
    cli.outputHelp();
    return;
  }

  const command = parseCommandName(safeString(cli.matchedCommandName).trim());
  const parsed = resolveParsedArgs(
    command,
    parsedArgv.options,
    process.argv.slice(2),
  );

  if (parsed.command === "update") return await runUpdate(parsed);
  if (parsed.command === "start") return await runStart(parsed);
  if (parsed.command === "stop") return await runStop(parsed);
  if (parsed.command === "restart") return await runRestart(parsed);
  if (parsed.command === "doctor") return await runDoctor(parsed);

  await launchDefaultRin(parsed);
}
