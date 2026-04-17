import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const pathsMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "paths.js"))
    .href
);

test("installer path helpers keep installed runtime roots stable", () => {
  const installDir = "/tmp/rin";
  assert.equal(
    pathsMod.installAppRoot(installDir),
    path.join(installDir, "app"),
  );
  assert.equal(
    pathsMod.currentRuntimeRoot(installDir),
    path.join(installDir, "app", "current"),
  );
  assert.equal(
    pathsMod.installedReleasesRoot(installDir),
    path.join(installDir, "app", "releases"),
  );
  assert.equal(
    pathsMod.installedReleaseRoot(installDir, "2026-04-17T10-00-00Z"),
    path.join(installDir, "app", "releases", "2026-04-17T10-00-00Z"),
  );
});

test("installer path helpers centralize installed and source entrypoints", () => {
  const installDir = "/tmp/rin";
  const repoRoot = "/repo";

  assert.deepEqual(pathsMod.installedAppEntryCandidates(installDir, "rin"), [
    path.join(installDir, "app", "current", "dist", "app", "rin", "main.js"),
    path.join(installDir, "app", "current", "dist", "index.js"),
  ]);
  assert.deepEqual(
    pathsMod.installedAppEntryCandidates(installDir, "rin-install"),
    [
      path.join(
        installDir,
        "app",
        "current",
        "dist",
        "app",
        "rin-install",
        "main.js",
      ),
    ],
  );
  assert.deepEqual(
    pathsMod.installedAppEntryCandidates(installDir, "rin-daemon"),
    [
      path.join(
        installDir,
        "app",
        "current",
        "dist",
        "app",
        "rin-daemon",
        "daemon.js",
      ),
      path.join(installDir, "app", "current", "dist", "daemon.js"),
    ],
  );
  assert.equal(
    pathsMod.sourceAppEntryPath(repoRoot, "rin-daemon"),
    path.join(repoRoot, "dist", "app", "rin-daemon", "daemon.js"),
  );
});
