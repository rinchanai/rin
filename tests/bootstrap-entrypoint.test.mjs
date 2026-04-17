import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-bootstrap-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
}

async function createSourceArchive(tempDir) {
  const sourceRoot = path.join(tempDir, "rin-main");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "package.json"), "{\n}\n", "utf8");
  await fs.writeFile(
    path.join(sourceRoot, "package-lock.json"),
    "{\n}\n",
    "utf8",
  );

  const archivePath = path.join(tempDir, "rin-main.tar.gz");
  await execFileAsync("tar", ["-czf", archivePath, "-C", tempDir, "rin-main"]);
  return archivePath;
}

async function createFakeBin(fakeBin, logPath) {
  await fs.mkdir(fakeBin, { recursive: true });

  await writeExecutable(
    path.join(fakeBin, "curl"),
    `#!/bin/sh\necho "curl:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"\nOUT=\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -o) OUT=$2; shift 2 ;;
    *) shift ;;
  esac\ndone\ncp "$RIN_BOOTSTRAP_TEST_ARCHIVE" "$OUT"\n`,
  );
  await writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/bin/sh\necho "npm:$PWD:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"\nif [ "$1" = "run" ] && [ "$2" = "build" ]; then\n  mkdir -p dist/app/rin-install\n  printf 'export {};\n' > dist/app/rin-install/main.js\nfi\n`,
  );
  await writeExecutable(
    path.join(fakeBin, "node"),
    `#!/bin/sh\necho "node:$PWD:RIN_INSTALL_MODE=\${RIN_INSTALL_MODE-}:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"\n`,
  );
  await fs.writeFile(logPath, "", "utf8");
}

async function runBootstrapWrapper(scriptName, env) {
  await execFileAsync("sh", [path.join(rootDir, scriptName)], {
    cwd: rootDir,
    env,
  });
}

test("install and update wrappers share one bootstrap entrypoint without leaving temp work dirs", async () => {
  await withTempDir(async (tempDir) => {
    const archivePath = await createSourceArchive(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "invocations.log");
    const workRoot = path.join(tempDir, "work");
    await createFakeBin(fakeBin, logPath);
    await fs.mkdir(workRoot, { recursive: true });

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
      RIN_INSTALL_TMPDIR: workRoot,
      RIN_BOOTSTRAP_TEST_ARCHIVE: archivePath,
      RIN_BOOTSTRAP_TEST_LOG: logPath,
    };

    await runBootstrapWrapper("install.sh", env);
    await runBootstrapWrapper("update.sh", env);

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/rin\/archive\/refs\/heads\/main\.tar\.gz -o /,
    );
    assert.match(log, /npm:.*:ci --no-fund --no-audit/);
    assert.match(log, /npm:.*:run build/);
    assert.match(
      log,
      /node:.*:RIN_INSTALL_MODE=:dist\/app\/rin-install\/main\.js/,
    );
    assert.match(
      log,
      /node:.*:RIN_INSTALL_MODE=update:dist\/app\/rin-install\/main\.js/,
    );

    assert.deepEqual(await fs.readdir(workRoot), []);
  });
});
