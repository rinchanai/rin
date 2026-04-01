import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const result = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.extensions.json",
    "--pretty",
    "false",
    "--noEmitOnError",
    "false",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env },
  },
);

const requiredOutputs = [
  path.join(repoRoot, "dist", "extensions", "memory", "index.js"),
  path.join(repoRoot, "dist", "extensions", "web-search", "index.js"),
  path.join(repoRoot, "dist", "extensions", "subagent", "index.js"),
];

if (requiredOutputs.every((filePath) => fs.existsSync(filePath))) {
  process.exit(0);
}
process.exit(result.status || 1);
