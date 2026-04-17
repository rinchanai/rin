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

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-install-service-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("installer service helpers prefer current daemon entry and sanitize unit paths", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "install");
    const currentDaemon = path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin-daemon",
      "daemon.js",
    );
    await fs.mkdir(path.dirname(currentDaemon), { recursive: true });
    await fs.writeFile(currentDaemon, "export {};\n", "utf8");

    const spec = service.buildSystemdUserService(
      "demo.user+test",
      installDir,
      () => "/home/demo",
      () => "/repo",
    );
    const plist = service.buildLaunchdPlist(
      "demo.user+test",
      installDir,
      () => "/Users/demo",
      () => "/repo",
    );

    assert.equal(spec.kind, "systemd");
    assert.equal(spec.label, "rin-daemon-demo.user-test.service");
    assert.ok(
      spec.servicePath.endsWith(
        path.join(
          "/home/demo",
          ".config",
          "systemd",
          "user",
          "rin-daemon-demo.user-test.service",
        ),
      ),
    );
    assert.match(
      spec.service,
      new RegExp(
        `^Environment=RIN_DIR=${installDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m",
      ),
    );
    assert.match(
      spec.service,
      new RegExp(
        `^ExecStart=${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${currentDaemon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m",
      ),
    );

    assert.equal(plist.label, "com.rin.daemon.demo.user-test");
    assert.ok(
      plist.plistPath.endsWith(
        path.join(
          "Library",
          "LaunchAgents",
          "com.rin.daemon.demo.user-test.plist",
        ),
      ),
    );
    assert.ok(plist.plist.includes(`<string>${process.execPath}</string>`));
    assert.ok(plist.plist.includes(`<string>${currentDaemon}</string>`));
    assert.ok(plist.plist.includes(`<string>${installDir}</string>`));
  });
});

test("resolveDaemonEntryForInstall falls back to legacy and repo daemon entries", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "install");
    const legacyDaemon = path.join(
      installDir,
      "app",
      "current",
      "dist",
      "daemon.js",
    );
    await fs.mkdir(path.dirname(legacyDaemon), { recursive: true });
    await fs.writeFile(legacyDaemon, "export {};\n", "utf8");

    assert.equal(
      service.resolveDaemonEntryForInstall(installDir, () => "/repo"),
      legacyDaemon,
    );

    await fs.rm(installDir, { recursive: true, force: true });
    assert.equal(
      service.resolveDaemonEntryForInstall(installDir, () => "/repo"),
      path.join("/repo", "dist", "app", "rin-daemon", "daemon.js"),
    );
  });
});
