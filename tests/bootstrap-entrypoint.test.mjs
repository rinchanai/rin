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

async function createReleaseManifest(tempDir) {
  const manifestPath = path.join(tempDir, "release-manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      repoUrl: "https://example.invalid/rin",
      bootstrapBranch: "stable-bootstrap",
      stable: {
        version: "1.2.3",
        archiveUrl: "https://example.invalid/releases/stable-1.2.3.tar.gz",
      },
      beta: {
        defaultBranch: "release/1.3",
        branches: {
          "release/1.3": {
            version: "1.3.0-beta.2",
            archiveUrl: "https://example.invalid/releases/release-1.3.tar.gz",
          },
        },
      },
      git: {
        defaultBranch: "main",
        repoUrl: "https://example.invalid/rin",
      },
    }),
    "utf8",
  );
  return manifestPath;
}

async function createFakeBin(fakeBin, logPath) {
  await fs.mkdir(fakeBin, { recursive: true });

  await writeExecutable(
    path.join(fakeBin, "curl"),
    `#!/bin/sh
echo "curl:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
OUT=
URL=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT=$2; shift 2 ;;
    *) URL=$1; shift ;;
  esac
done
case "$URL" in
  *release-manifest.json)
    cp "$RIN_BOOTSTRAP_TEST_MANIFEST" "$OUT"
    ;;
  *)
    cp "$RIN_BOOTSTRAP_TEST_ARCHIVE" "$OUT"
    ;;
esac
`,
  );
  await writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/bin/sh
echo "npm:$PWD:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p dist/app/rin-install
  printf 'export {};\n' > dist/app/rin-install/main.js
fi
`,
  );
  await writeExecutable(
    path.join(fakeBin, "node"),
    `#!/bin/sh
echo "node:$PWD:RIN_INSTALL_MODE=\${RIN_INSTALL_MODE-}:RIN_RELEASE_CHANNEL=\${RIN_RELEASE_CHANNEL-}:$*" >>"$RIN_BOOTSTRAP_TEST_LOG"
if [ "$1" = "-" ]; then
  cat <<'EOF'
CHANNEL='stable'
ARCHIVE_URL='https://example.invalid/releases/stable-1.2.3.tar.gz'
VERSION='1.2.3'
BRANCH='stable'
REF='1.2.3'
SOURCE_LABEL='stable 1.2.3'
EOF
fi
`,
  );
  await fs.writeFile(logPath, "", "utf8");
}

async function runBootstrapWrapper(scriptName, env) {
  await execFileAsync("sh", [path.join(rootDir, scriptName)], {
    cwd: rootDir,
    env,
  });
}

test("install and update wrappers resolve release metadata before fetching source and leave no temp work dirs", async () => {
  await withTempDir(async (tempDir) => {
    const archivePath = await createSourceArchive(tempDir);
    const manifestPath = await createReleaseManifest(tempDir);
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
      RIN_BOOTSTRAP_TEST_MANIFEST: manifestPath,
      RIN_BOOTSTRAP_TEST_LOG: logPath,
    };

    await runBootstrapWrapper("install.sh", env);
    await runBootstrapWrapper("update.sh", env);

    const log = await fs.readFile(logPath, "utf8");
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/rin\/stable-bootstrap\/release-manifest\.json -o /,
    );
    assert.match(
      log,
      /curl:-fsSL https:\/\/example\.invalid\/releases\/stable-1\.2\.3\.tar\.gz -o /,
    );
    assert.match(log, /npm:.*:ci --no-fund --no-audit/);
    assert.match(log, /npm:.*:run build/);
    assert.match(
      log,
      /node:.*:RIN_INSTALL_MODE=:RIN_RELEASE_CHANNEL=stable:dist\/app\/rin-install\/main\.js/,
    );
    assert.match(
      log,
      /node:.*:RIN_INSTALL_MODE=update:RIN_RELEASE_CHANNEL=stable:dist\/app\/rin-install\/main\.js/,
    );

    assert.deepEqual(await fs.readdir(workRoot), []);
  });
});
