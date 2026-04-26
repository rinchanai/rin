#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function buildPrettierFormatCheckArgs(targets = []) {
  return [
    "--check",
    "--ignore-unknown",
    "--ignore-path",
    ".prettierignore",
    ...(targets.length > 0 ? targets : ["."]),
  ];
}

export function main(argv = process.argv.slice(2)) {
  const result = spawnSync("prettier", buildPrettierFormatCheckArgs(argv), {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
