#!/usr/bin/env node
import { resolveRuntimeProfile } from "../../core/rin-lib/runtime.js";
import {
  attachHiddenSession,
  parseHiddenSessionSpecFromEnv,
  runHiddenSessionHost,
  runHiddenSessionList,
  sanitizeHiddenSessionName,
} from "../../core/rin/hidden-session.js";
import { repoRootFromHere } from "../../core/rin/shared.js";

function parseAttachArgs(argv: string[]) {
  const args = [...argv];
  const name = sanitizeHiddenSessionName(args.shift() || "");
  let mode: "rpc" | "std" = "rpc";
  const passthrough: string[] = [];
  while (args.length > 0) {
    const arg = String(args.shift() || "");
    if (arg === "--std") {
      mode = "std";
      continue;
    }
    if (arg === "--rpc") {
      mode = "rpc";
      continue;
    }
    if (arg === "--") {
      passthrough.push(...args);
      break;
    }
    passthrough.push(arg);
  }
  const profile = resolveRuntimeProfile();
  return {
    name,
    mode,
    passthrough,
    repoRoot: repoRootFromHere(),
    agentDir: profile.agentDir,
  };
}

async function main() {
  const command = String(process.argv[2] || "").trim();
  if (command === "host") {
    await runHiddenSessionHost(parseHiddenSessionSpecFromEnv());
    return;
  }
  if (command === "list") {
    await runHiddenSessionList(resolveRuntimeProfile().agentDir);
    return;
  }
  if (command === "attach") {
    await attachHiddenSession(parseAttachArgs(process.argv.slice(3)));
    return;
  }
  throw new Error("rin_hidden_session_command_required");
}

main().catch((error: any) => {
  console.error(String(error?.message || error || "rin_hidden_session_failed"));
  process.exit(1);
});
