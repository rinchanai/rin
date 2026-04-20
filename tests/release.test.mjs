import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href,
);
const release = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "release.js")).href,
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
  assert.throws(
    () =>
      shared.resolveParsedArgs(
        "update",
        { beta: true, branch: "release/0.69", version: "0.69.0-beta.1" },
        [
          "update",
          "--beta",
          "--branch",
          "release/0.69",
          "--version",
          "0.69.0-beta.1",
        ],
      ),
    /rin_release_branch_and_version_conflict/,
  );
});

test("resolveReleaseRequest resolves stable beta and git sources", () => {
  const manifest = {
    packageName: "@rinchanai/rin",
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

  assert.deepEqual(release.resolveReleaseRequest(manifest, { channel: "stable" }), {
    channel: "stable",
    archiveUrl: "https://example.com/stable-1.2.3.tgz",
    version: "1.2.3",
    branch: "stable",
    ref: "1.2.3",
    sourceLabel: "stable 1.2.3",
  });

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

  const stableFallback = release.resolveReleaseRequest(
    {
      packageName: "@rinchanai/rin",
      repoUrl: "https://github.com/rinchanai/rin",
      stable: { version: "1.2.3" },
      beta: manifest.beta,
      git: manifest.git,
    },
    { channel: "stable" },
  );
  assert.equal(
    stableFallback.archiveUrl,
    "https://registry.npmjs.org/%40rinchanai%2Frin/-/rin-1.2.3.tgz",
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

test("readBundledReleaseManifest falls back to bundled defaults", () => {
  const manifest = release.readBundledReleaseManifest(path.join(rootDir, ".missing-release-manifest-root"));
  assert.equal(manifest.packageName, "@rinchanai/rin");
  assert.equal(manifest.bootstrapBranch, "stable-bootstrap");
  assert.equal(manifest.stable.version, "0.0.0");
  assert.equal(
    manifest.stable.archiveUrl,
    "https://github.com/rinchanai/rin/archive/refs/heads/main.tar.gz",
  );
});

test("releaseInfoFromEnv normalizes installer bootstrap metadata", () => {
  const env = {
    ...process.env,
    RIN_RELEASE_CHANNEL: process.env.RIN_RELEASE_CHANNEL,
    RIN_RELEASE_VERSION: process.env.RIN_RELEASE_VERSION,
    RIN_RELEASE_BRANCH: process.env.RIN_RELEASE_BRANCH,
    RIN_RELEASE_REF: process.env.RIN_RELEASE_REF,
    RIN_RELEASE_SOURCE_LABEL: process.env.RIN_RELEASE_SOURCE_LABEL,
    RIN_RELEASE_ARCHIVE_URL: process.env.RIN_RELEASE_ARCHIVE_URL,
  };
  process.env.RIN_RELEASE_CHANNEL = "beta";
  process.env.RIN_RELEASE_VERSION = "1.3.0-beta.2";
  process.env.RIN_RELEASE_BRANCH = "release/1.3";
  process.env.RIN_RELEASE_REF = "1.3.0-beta.2";
  process.env.RIN_RELEASE_SOURCE_LABEL = "beta version 1.3.0-beta.2";
  process.env.RIN_RELEASE_ARCHIVE_URL = "https://example.com/release-1.3-beta.2.tgz";
  try {
    const info = release.releaseInfoFromEnv();
    assert.equal(info.channel, "beta");
    assert.equal(info.version, "1.3.0-beta.2");
    assert.equal(info.branch, "release/1.3");
    assert.equal(info.ref, "1.3.0-beta.2");
    assert.equal(info.sourceLabel, "beta version 1.3.0-beta.2");
    assert.equal(info.archiveUrl, "https://example.com/release-1.3-beta.2.tgz");
    assert.match(String(info.installedAt || ""), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
