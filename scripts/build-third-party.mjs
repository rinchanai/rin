import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const projectRoot = path.join(repoRoot, "third_party", "pi-coding-agent");
const distRoot = path.join(projectRoot, "dist");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(sourcePath, destPath) {
  ensureDir(path.dirname(destPath));
  fs.copyFileSync(sourcePath, destPath);
}

function copyGlobDir(sourceDir, destDir, predicate = () => true) {
  if (!fs.existsSync(sourceDir)) return;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyGlobDir(sourcePath, destPath, predicate);
      continue;
    }
    if (predicate(sourcePath)) copyFile(sourcePath, destPath);
  }
}

const result = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.build.json",
    "--pretty",
    "false",
    "--noEmitOnError",
    "false",
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env },
  },
);

if (!fs.existsSync(path.join(distRoot, "index.js"))) {
  process.exit(result.status || 1);
}

copyGlobDir(
  path.join(projectRoot, "src", "modes", "interactive", "theme"),
  path.join(distRoot, "modes", "interactive", "theme"),
  (filePath) => filePath.endsWith(".json"),
);
copyGlobDir(
  path.join(projectRoot, "src", "core", "export-html"),
  path.join(distRoot, "core", "export-html"),
  (filePath) => /template\.(html|css|js)$/.test(path.basename(filePath)),
);
copyGlobDir(
  path.join(projectRoot, "src", "core", "export-html", "vendor"),
  path.join(distRoot, "core", "export-html", "vendor"),
);

process.exit(0);
