#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { startRinCli } from "../../core/rin/main.js";

export async function main(
  deps: {
    startRinCli?: typeof startRinCli;
  } = {},
) {
  await (deps.startRinCli ?? startRinCli)();
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    console.error(String(error?.message || error || "rin_app_cli_failed"));
    process.exit(1);
  });
}
