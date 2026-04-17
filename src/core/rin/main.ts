#!/usr/bin/env node
import { cac } from "cac";

import { runStart, runStop, runRestart } from "./control.js";
import { runDoctor } from "./doctor.js";
import { launchDefaultRin } from "./launch.js";
import { runMemoryIndex, runMemoryIndexInternal } from "./memory-index.js";
import {
  ParsedArgs,
  resolveParsedArgs,
  runUpdate,
  safeString,
} from "./shared.js";
import { runUsage, runUsageInternal } from "./usage.js";

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
    .option("--tmux-list", "List hidden Rin tmux sessions")
    .option("--stable", "Use the stable release channel (default)")
    .option("--beta", "Use the beta release channel")
    .option("--git", "Use the git release channel")
    .option("--branch <name>", "Use a specific beta/git branch")
    .option("--version <value>", "Use a specific release version or git ref")
    .help();

  cli.command(
    "update",
    "Update the installed Rin core runtime for the target user (does not update the CLI launcher)",
  );
  cli.command("start", "Start the target user daemon");
  cli.command("stop", "Stop the target user daemon");
  cli.command("restart", "Restart the target user daemon");
  cli.command("doctor", "Show daemon/socket diagnostics for the target user");
  cli.command("usage", "Show token telemetry dashboard and grouped usage stats");
  cli.command("memory-index", "Repair the memory search index from archived transcripts");

  return cli;
}

function parseCommandName(name: string): ParsedArgs["command"] {
  return ["update", "start", "stop", "restart", "doctor", "usage", "memory-index"].includes(name)
    ? (name as ParsedArgs["command"])
    : "";
}

export async function startRinCli() {
  if (process.argv[2] === "__usage_internal") {
    await runUsageInternal(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "__memory_index_internal") {
    await runMemoryIndexInternal(process.argv.slice(3));
    return;
  }
  if (
    process.argv[2] === "usage" &&
    process.argv.slice(3).some((arg) => arg === "--help" || arg === "-h")
  ) {
    await runUsageInternal(["--help"]);
    return;
  }
  if (
    process.argv[2] === "memory-index" &&
    process.argv.slice(3).some((arg) => arg === "--help" || arg === "-h")
  ) {
    await runMemoryIndexInternal(["--help"]);
    return;
  }

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
  if (parsed.command === "usage") return await runUsage(parsed, process.argv.slice(2));
  if (parsed.command === "memory-index")
    return await runMemoryIndex(parsed, process.argv.slice(2));

  await launchDefaultRin(parsed);
}
