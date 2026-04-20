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
    assert.equal(next.packageName, "@rinchanai/rin");
    assert.equal(next.stable.version, "1.2.3");
    assert.equal(
      next.stable.archiveUrl,
      "https://registry.npmjs.org/%40rinchanai%2Frin/-/rin-1.2.3.tgz",
    );
    assert.equal(
      next.stable.versions["1.2.3"].archiveUrl,
      "https://registry.npmjs.org/%40rinchanai%2Frin/-/rin-1.2.3.tgz",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("update-release-manifest script writes beta GitHub branch metadata", () => {
  const tempDir = makeTempDir(".tmp-release-script-");
  try {
    const manifestPath = path.join(tempDir, "release-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        packageName: "@rinchanai/rin",
        repoUrl: "https://github.com/rinchanai/rin",
        stable: { version: "1.2.3", archiveUrl: "https://registry.npmjs.org/%40rinchanai%2Frin/-/rin-1.2.3.tgz" },
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
        "beta",
        "--branch",
        "release/1.3",
        "--version",
        "1.3.0-beta.2",
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
    const next = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(next.beta.branches["release/1.3"].version, "1.3.0-beta.2");
    assert.equal(
      next.beta.branches["release/1.3"].archiveUrl,
      "https://github.com/rinchanai/rin/archive/refs/heads/release/1.3.tar.gz",
    );
    assert.equal(next.beta.versions["1.3.0-beta.2"].branch, "release/1.3");
    assert.equal(
      next.beta.versions["1.3.0-beta.2"].archiveUrl,
      "https://github.com/rinchanai/rin/archive/refs/heads/release/1.3.tar.gz",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("export-bootstrap-branch script exports stable bootstrap payload", () => {
  const tempDir = makeTempDir(".tmp-bootstrap-export-");
  try {
    fs.writeFileSync(path.join(tempDir, "stale.txt"), "stale", "utf8");
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
    assert.equal(fs.existsSync(path.join(tempDir, "stale.txt")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
