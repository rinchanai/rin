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

test("installer path helpers centralize home, config, service, and log locations", () => {
  const linuxHome = "/home/demo";
  const macHome = "/Users/demo";
  const installDir = "/srv/rin-demo";

  assert.equal(pathsMod.defaultHomeRoot("linux"), "/home");
  assert.equal(pathsMod.defaultHomeRoot("darwin"), "/Users");
  assert.equal(pathsMod.defaultHomeForUser("demo", "linux"), linuxHome);
  assert.equal(pathsMod.defaultHomeForUser("demo", "darwin"), macHome);
  assert.equal(
    pathsMod.installSettingsPath(installDir),
    path.join(installDir, "settings.json"),
  );
  assert.equal(
    pathsMod.installAuthPath(installDir),
    path.join(installDir, "auth.json"),
  );
  assert.equal(
    pathsMod.localBinDirForHome(linuxHome),
    path.join(linuxHome, ".local", "bin"),
  );
  assert.equal(
    pathsMod.launcherPathForHome(linuxHome, "rin"),
    path.join(linuxHome, ".local", "bin", "rin"),
  );
  assert.equal(
    pathsMod.launcherMetadataPathForHome(linuxHome, "linux"),
    path.join(linuxHome, ".config", "rin", "install.json"),
  );
  assert.equal(
    pathsMod.launcherMetadataPathForHome(macHome, "darwin"),
    path.join(macHome, "Library", "Application Support", "rin", "install.json"),
  );
  assert.equal(
    pathsMod.launchAgentPlistPathForHome(macHome, "com.rin.daemon.demo"),
    path.join(macHome, "Library", "LaunchAgents", "com.rin.daemon.demo.plist"),
  );
  assert.equal(
    pathsMod.systemdUserUnitPathForHome(linuxHome, "rin-daemon-demo.service"),
    path.join(
      linuxHome,
      ".config",
      "systemd",
      "user",
      "rin-daemon-demo.service",
    ),
  );
  assert.equal(
    pathsMod.daemonStdoutLogPath(installDir),
    path.join(installDir, "data", "logs", "daemon.stdout.log"),
  );
  assert.equal(
    pathsMod.daemonStderrLogPath(installDir),
    path.join(installDir, "data", "logs", "daemon.stderr.log"),
  );
});
