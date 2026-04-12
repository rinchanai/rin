import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const service = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "service.js"))
    .href
);

test("installer service helpers build systemd service spec", () => {
  const spec = service.buildSystemdUserService(
    "demo",
    "/tmp/rin",
    () => "/home/demo",
    () => "/repo",
  );
  assert.equal(spec.kind, "systemd");
  assert.ok(spec.service.includes("Environment=RIN_DIR=/tmp/rin"));
  assert.ok(spec.service.includes("Description=Rin daemon for demo"));
  assert.ok(spec.servicePath.includes(path.join(".config", "systemd", "user")));
});

test("installer service helpers prefer current daemon entry and then legacy fallback", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-install-service-"),
  );
  try {
    const currentEntry = path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin-daemon",
      "daemon.js",
    );
    await fs.mkdir(path.dirname(currentEntry), { recursive: true });
    await fs.writeFile(currentEntry, "export {};", "utf8");

    assert.equal(
      service.resolveDaemonEntryForInstall(installDir, () => "/repo"),
      currentEntry,
    );

    await fs.rm(path.join(installDir, "app"), { recursive: true, force: true });
    const legacyEntry = path.join(
      installDir,
      "app",
      "current",
      "dist",
      "daemon.js",
    );
    await fs.mkdir(path.dirname(legacyEntry), { recursive: true });
    await fs.writeFile(legacyEntry, "export {};", "utf8");

    assert.equal(
      service.resolveDaemonEntryForInstall(installDir, () => "/repo"),
      legacyEntry,
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("installer service helpers fall back to repo daemon entry when install runtime is absent", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-install-service-"),
  );
  try {
    assert.equal(
      service.resolveDaemonEntryForInstall(installDir, () => "/repo"),
      path.join("/repo", "dist", "app", "rin-daemon", "daemon.js"),
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("installer service helpers build launchd plist with stable daemon environment", () => {
  const spec = service.buildLaunchdPlist(
    "demo user",
    "/tmp/rin",
    () => "/Users/demo",
    () => "/repo",
  );
  assert.equal(spec.label, "com.rin.daemon.demo-user");
  assert.equal(
    spec.plistPath,
    path.join(
      "/Users/demo",
      "Library",
      "LaunchAgents",
      "com.rin.daemon.demo-user.plist",
    ),
  );
  assert.ok(spec.plist.includes("<key>RIN_DIR</key>"));
  assert.ok(spec.plist.includes("<string>/tmp/rin</string>"));
  assert.ok(spec.plist.includes("<string>/Users/demo</string>"));
});
