import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href
);
const release = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "release.js")).href
);
const changelog = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "changelog.js")).href
);

test("resolveParsedArgs defaults update channel to stable", () => {
  const parsed = shared.resolveParsedArgs("update", {}, []);
  assert.equal(parsed.releaseChannel, "stable");
  assert.equal(parsed.releaseBranch, "");
  assert.equal(parsed.releaseVersion, "");
});

test("resolveParsedArgs accepts explicit beta branch and git version", () => {
  const betaParsed = shared.resolveParsedArgs(
    "update",
    { beta: true, branch: "release/0.69" },
    ["update", "--beta", "--branch", "release/0.69"],
  );
  assert.equal(betaParsed.releaseChannel, "beta");
  assert.equal(betaParsed.releaseBranch, "release/0.69");

  const gitParsed = shared.resolveParsedArgs(
    "update",
    { git: true, version: "deadbeef" },
    ["update", "--git", "--version", "deadbeef"],
  );
  assert.equal(gitParsed.releaseChannel, "git");
  assert.equal(gitParsed.releaseVersion, "deadbeef");
});

test("resolveParsedArgs rejects conflicting release selectors", () => {
  assert.throws(
    () =>
      shared.resolveParsedArgs(
        "update",
        { beta: true, git: true },
        ["update", "--beta", "--git"],
      ),
    /rin_release_channel_conflict/,
  );
  assert.throws(
    () =>
      shared.resolveParsedArgs(
        "update",
        { stable: true, branch: "release/0.69" },
        ["update", "--stable", "--branch", "release/0.69"],
      ),
    /rin_stable_branch_not_supported/,
  );
});

test("resolveReleaseRequest resolves stable beta and git sources", () => {
  const manifest = {
    repoUrl: "https://github.com/rinchanai/rin",
    stable: {
      version: "1.2.3",
      archiveUrl: "https://example.com/stable-1.2.3.tgz",
    },
    beta: {
      defaultBranch: "release/1.3",
      branches: {
        "release/1.3": {
          version: "1.3.0-beta.2",
          archiveUrl: "https://example.com/release-1.3-beta.2.tgz",
        },
      },
      versions: {
        "1.3.0-beta.1": {
          branch: "release/1.3",
          archiveUrl: "https://example.com/release-1.3-beta.1.tgz",
        },
      },
    },
    git: {
      defaultBranch: "main",
    },
  };

  assert.deepEqual(
    release.resolveReleaseRequest(manifest, { channel: "stable" }),
    {
      channel: "stable",
      archiveUrl: "https://example.com/stable-1.2.3.tgz",
      version: "1.2.3",
      branch: "stable",
      ref: "1.2.3",
      sourceLabel: "stable 1.2.3",
    },
  );

  assert.deepEqual(
    release.resolveReleaseRequest(manifest, {
      channel: "beta",
      branch: "release/1.3",
    }),
    {
      channel: "beta",
      archiveUrl: "https://example.com/release-1.3-beta.2.tgz",
      version: "1.3.0-beta.2",
      branch: "release/1.3",
      ref: "release/1.3",
      sourceLabel: "beta branch release/1.3",
    },
  );

  const gitResolved = release.resolveReleaseRequest(manifest, {
    channel: "git",
    version: "deadbeef",
  });
  assert.equal(gitResolved.channel, "git");
  assert.equal(gitResolved.ref, "deadbeef");
  assert.equal(
    gitResolved.archiveUrl,
    "https://github.com/rinchanai/rin/archive/deadbeef.tar.gz",
  );
});

test("readInstalledReleaseInfo reads persisted installer release metadata", () => {
  const tempRoot = fs.mkdtempSync(path.join(rootDir, ".tmp-rin-release-info-"));
  try {
    fs.writeFileSync(
      path.join(tempRoot, "installer.json"),
      JSON.stringify({
        release: {
          channel: "beta",
          version: "1.3.0-beta.2",
          branch: "release/1.3",
          ref: "release/1.3",
          sourceLabel: "beta branch release/1.3",
          archiveUrl: "https://example.com/release-1.3-beta.2.tgz",
          installedAt: "2026-04-17T08:00:00.000Z",
        },
      }),
    );
    assert.deepEqual(release.readInstalledReleaseInfo(tempRoot), {
      channel: "beta",
      version: "1.3.0-beta.2",
      branch: "release/1.3",
      ref: "release/1.3",
      sourceLabel: "beta branch release/1.3",
      archiveUrl: "https://example.com/release-1.3-beta.2.tgz",
      installedAt: "2026-04-17T08:00:00.000Z",
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("parseChangelog extracts versions and filters newer entries", () => {
  const tempRoot = fs.mkdtempSync(path.join(rootDir, ".tmp-rin-changelog-"));
  const changelogPath = path.join(tempRoot, "CHANGELOG.md");
  try {
    fs.writeFileSync(
      changelogPath,
      [
        "# Rin Changelog",
        "",
        "## 1.2.0",
        "",
        "- stable release",
        "",
        "## 1.1.0",
        "",
        "- previous release",
        "",
        "## 1.0.0",
        "",
        "- first release",
        "",
      ].join("\n"),
    );
    const entries = changelog.parseChangelog(changelogPath);
    assert.deepEqual(
      entries.map((entry) => entry.version),
      ["1.2.0", "1.1.0", "1.0.0"],
    );
    const newer = changelog.getNewerChangelogEntries(entries, "1.0.0", "1.2.0");
    assert.deepEqual(
      newer.map((entry) => entry.version),
      ["1.2.0", "1.1.0"],
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
