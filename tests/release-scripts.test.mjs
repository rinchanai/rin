import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(rootDir, prefix));
}

test("update-release-manifest script writes stable npm tarball metadata", () => {
  const tempDir = makeTempDir(".tmp-release-script-");
  try {
    const manifestPath = path.join(tempDir, "release-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        packageName: "@rinchanai/rin",
        repoUrl: "https://github.com/rinchanai/rin",
        stable: { version: "0.0.0", archiveUrl: "https://example.com/old.tgz" },
        beta: { defaultBranch: "release/next", branches: {}, versions: {} },
        git: { defaultBranch: "main" },
      }),
    );
    execFileSync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "update-release-manifest.mjs"),
        "--manifest",
        manifestPath,
        "--channel",
        "stable",
        "--version",
        "1.2.3",
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    const next = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(next.stable.version, "1.2.3");
    assert.equal(
      next.stable.archiveUrl,
      "https://registry.npmjs.org/%40rinchanai%2Frin/-/rin-1.2.3.tgz",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("export-bootstrap-branch script exports bootstrap files", () => {
  const tempDir = makeTempDir(".tmp-bootstrap-export-");
  try {
    execFileSync(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release", "export-bootstrap-branch.mjs"),
        "--output",
        tempDir,
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    for (const relativePath of [
      "install.sh",
      "update.sh",
      "release-manifest.json",
      path.join("docs", "rin", "CHANGELOG.md"),
      "README.md",
    ]) {
      assert.equal(fs.existsSync(path.join(tempDir, relativePath)), true, relativePath);
    }
    const readme = fs.readFileSync(path.join(tempDir, "README.md"), "utf8");
    assert.match(readme, /stable bootstrap branch/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
