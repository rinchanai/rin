#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...options,
  }).trim();
}

function findRepoRoot(cwd) {
  try {
    return runGit(["rev-parse", "--show-toplevel"], { cwd }) || null;
  } catch {
    return null;
  }
}

const cwd = process.cwd();
const repoRoot = findRepoRoot(cwd);
if (!repoRoot) process.exit(0);

const hooksDir = path.join(repoRoot, ".githooks");
const preCommit = path.join(hooksDir, "pre-commit");
if (!fs.existsSync(preCommit)) process.exit(0);

try {
  fs.chmodSync(preCommit, 0o755);
} catch {
  // The executable bit is tracked by git; chmod is only a best-effort repair for odd filesystems.
}

runGit(["config", "core.hooksPath", ".githooks"], { cwd: repoRoot });
console.log("rin git hooks: configured core.hooksPath=.githooks");
