#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const targets = process.argv.slice(2);
const args = [
  "--check",
  "--ignore-unknown",
  "--ignore-path",
  ".prettierignore",
];

if (targets.length > 0) {
  args.push(...targets);
} else {
  args.push(".");
}

const result = spawnSync("prettier", args, { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
