import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const installScriptPath = path.join(rootDir, "install.sh");

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
}

async function makeArchive(workDir, { withLockfile }) {
  const sourceDir = path.join(workDir, "archive-src");
  const archivePath = path.join(workDir, "rin.tar.gz");
  await fs.mkdir(path.join(sourceDir, "dist", "app", "rin-install"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(sourceDir, "package.json"),
    JSON.stringify({ name: "rin-test", private: true }),
  );
  if (withLockfile) {
    await fs.writeFile(path.join(sourceDir, "package-lock.json"), "{}\n");
  }
  await fs.writeFile(
    path.join(sourceDir, "dist", "app", "rin-install", "main.js"),
    'console.log("installer-entry");\n',
  );

  const tarResult = spawnSync(
    "tar",
    ["-czf", archivePath, "-C", sourceDir, "."],
    { encoding: "utf8" },
  );
  assert.equal(tarResult.status, 0, tarResult.stderr || tarResult.stdout);
  return archivePath;
}

async function makeTooling(workDir, archivePath, { useCurl, useWget }) {
  const binDir = path.join(workDir, "bin");
  const logDir = path.join(workDir, "logs");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });

  for (const tool of [
    "tar",
    "mkdir",
    "mktemp",
    "rm",
    "tail",
    "tty",
    "cp",
    "sleep",
    "gzip",
  ]) {
    await writeExecutable(
      path.join(binDir, tool),
      `#!/bin/sh\nexec /usr/bin/${tool} "$@"\n`,
    );
  }

  if (useCurl) {
    await writeExecutable(
      path.join(binDir, "curl"),
      `#!/bin/sh
set -eu
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out=$2
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cp "$RIN_TEST_ARCHIVE" "$out"
`,
    );
  }

  if (useWget) {
    await writeExecutable(
      path.join(binDir, "wget"),
      `#!/bin/sh
set -eu
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -qO)
      out=$2
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cp "$RIN_TEST_ARCHIVE" "$out"
`,
    );
  }

  await writeExecutable(
    path.join(binDir, "npm"),
    `#!/bin/sh
set -eu
printf '%s|%s\n' "$PWD" "$*" >> "$RIN_TEST_NPM_LOG"
exit 0
`,
  );

  await writeExecutable(
    path.join(binDir, "node"),
    `#!/bin/sh
set -eu
printf '%s|%s\n' "$PWD" "$*" >> "$RIN_TEST_NODE_LOG"
exit 0
`,
  );

  return {
    binDir,
    npmLog: path.join(logDir, "npm.log"),
    nodeLog: path.join(logDir, "node.log"),
    archivePath,
  };
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-install-script-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runInstallScript({ withLockfile, useCurl, useWget }) {
  return await withTempDir(async (workDir) => {
    const archivePath = await makeArchive(workDir, { withLockfile });
    const tooling = await makeTooling(workDir, archivePath, {
      useCurl,
      useWget,
    });
    const cacheDir = path.join(workDir, "cache");
    await fs.mkdir(cacheDir, { recursive: true });

    const env = {
      ...process.env,
      PATH: tooling.binDir,
      HOME: path.join(workDir, "home"),
      XDG_CACHE_HOME: cacheDir,
      RIN_INSTALL_TMPDIR: path.join(cacheDir, "bootstrap"),
      RIN_INSTALL_REPO_URL: "https://example.invalid/rin",
      RIN_TEST_ARCHIVE: archivePath,
      RIN_TEST_NPM_LOG: tooling.npmLog,
      RIN_TEST_NODE_LOG: tooling.nodeLog,
    };

    const result = spawnSync("/bin/sh", [installScriptPath], {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });

    const npmLog = await fs.readFile(tooling.npmLog, "utf8").catch(() => "");
    const nodeLog = await fs.readFile(tooling.nodeLog, "utf8").catch(() => "");
    const tmpEntries = await fs
      .readdir(path.join(cacheDir, "bootstrap"))
      .catch(() => []);

    return { result, npmLog, nodeLog, tmpEntries };
  });
}

test("install.sh uses curl plus npm ci when a lockfile is present and cleans up temp workdirs", async () => {
  const { result, npmLog, nodeLog, tmpEntries } = await runInstallScript({
    withLockfile: true,
    useCurl: true,
    useWget: false,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[rin-install\] Launching installer/);
  assert.match(npmLog, /\|ci --no-fund --no-audit/);
  assert.match(npmLog, /\|run build/);
  assert.match(nodeLog, /dist\/app\/rin-install\/main\.js/);
  assert.deepEqual(tmpEntries, []);
});

test("install.sh falls back to wget and npm install when package-lock.json is absent", async () => {
  const { result, npmLog, nodeLog } = await runInstallScript({
    withLockfile: false,
    useCurl: false,
    useWget: true,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(npmLog, /\|ci --no-fund --no-audit/);
  assert.match(npmLog, /\|install --no-fund --no-audit/);
  assert.match(npmLog, /\|run build/);
  assert.match(nodeLog, /dist\/app\/rin-install\/main\.js/);
});

test("install.sh fails early with a clear error when neither curl nor wget is available", async () => {
  const { result, npmLog, nodeLog } = await runInstallScript({
    withLockfile: true,
    useCurl: false,
    useWget: false,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rin installer requires curl or wget/);
  assert.equal(npmLog, "");
  assert.equal(nodeLog, "");
});
