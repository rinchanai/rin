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
const managedService = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "managed-service.js"),
  ).href
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
    );
    const plist = service.buildLaunchdPlist(
      "demo.user+test",
      installDir,
      () => "/Users/demo",
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
        `^ExecStart=/usr/bin/env node ${currentDaemon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m",
      ),
    );
    assert.match(spec.service, /^Environment=PATH=.+$/m);

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
    assert.ok(plist.plist.includes(`<string>/usr/bin/env</string>`));
    assert.ok(plist.plist.includes(`<string>node</string>`));
    assert.ok(plist.plist.includes(`<string>${currentDaemon}</string>`));
    assert.ok(plist.plist.includes(`<key>PATH</key>`));
    assert.ok(plist.plist.includes(`<string>${installDir}</string>`));
  });
});

test("resolveDaemonEntryForInstall falls back to legacy installed daemon entry and fails without an installed runtime", async () => {
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
      service.resolveDaemonEntryForInstall(installDir),
      legacyDaemon,
    );

    await fs.rm(installDir, { recursive: true, force: true });
    assert.throws(
      () => service.resolveDaemonEntryForInstall(installDir),
      /rin_installed_daemon_entry_missing:/,
    );
  });
});

test("refreshManagedServiceFiles updates existing managed units without creating missing candidates", async () => {
  if (process.platform !== "linux") return;

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
    const targetHome = path.join(dir, "home");
    const unitDir = path.join(targetHome, ".config", "systemd", "user");
    const currentUnit = path.join(unitDir, "rin-daemon-demo.user-test.service");
    const legacyUnit = path.join(unitDir, "rin-daemon.service");

    await fs.mkdir(path.dirname(currentDaemon), { recursive: true });
    await fs.writeFile(currentDaemon, "export {};\n", "utf8");
    await fs.mkdir(unitDir, { recursive: true });
    await fs.writeFile(legacyUnit, "stale\n", "utf8");

    service.refreshManagedServiceFiles("demo.user+test", installDir, false, {
      findSystemUser: () => ({ gid: 123 }),
      targetHomeForUser: () => targetHome,
    });

    const spec = service.buildSystemdUserService(
      "demo.user+test",
      installDir,
      () => targetHome,
    );
    assert.equal(await fs.readFile(legacyUnit, "utf8"), spec.service);
    assert.equal((await fs.stat(legacyUnit)).mode & 0o777, 0o644);
    await assert.rejects(fs.access(currentUnit), /ENOENT/);
  });
});

test("systemdUserContext keeps managed unit candidates ordered", () => {
  const context = service.systemdUserContext("demo.user+test", {
    findSystemUser: () => ({ uid: -1 }),
  });
  assert.deepEqual(context.units, [
    "rin-daemon-demo.user-test.service",
    "rin-daemon.service",
  ]);
  assert.deepEqual(context.userEnv, {});
});

test("managed systemd helpers keep first matching unit semantics", () => {
  const units = [
    "missing.service",
    "rin-daemon-demo.service",
    "rin-daemon.service",
  ];
  const calls = [];

  const status = managedService.findManagedSystemdStatusSnapshot(
    units,
    (unit) => {
      calls.push(`status:${unit}`);
      if (unit === "missing.service")
        throw { stderr: "Unit missing.service could not be found" };
      if (unit === "rin-daemon-demo.service")
        return "● rin-daemon-demo.service - Demo\n   Active: active (running)";
      return "";
    },
  );
  assert.deepEqual(status, {
    unit: "missing.service",
    lines: ["Unit missing.service could not be found"],
  });

  const journal = managedService.findManagedSystemdJournalSnapshot(
    units,
    (unit) => {
      calls.push(`journal:${unit}`);
      if (unit === "missing.service") return "";
      if (unit === "rin-daemon-demo.service")
        return "older\nrecent one\nrecent two";
      return "";
    },
    2,
  );
  assert.deepEqual(journal, {
    unit: "rin-daemon-demo.service",
    lines: ["recent one", "recent two"],
  });

  const actionUnit = managedService.tryManagedSystemdAction(units, {
    daemonReload: () => calls.push("reload"),
    probeUnit: (unit) => {
      calls.push(`probe:${unit}`);
      if (unit === "missing.service") throw new Error("missing");
    },
    runAction: (unit) => calls.push(`run:${unit}`),
  });
  assert.equal(actionUnit, "rin-daemon-demo.service");
  assert.deepEqual(calls, [
    "status:missing.service",
    "journal:missing.service",
    "journal:rin-daemon-demo.service",
    "reload",
    "probe:missing.service",
    "probe:rin-daemon-demo.service",
    "run:rin-daemon-demo.service",
  ]);
});

test("daemonSocketPathForUser prefers runtime dir and falls back to home cache", () => {
  if (process.platform !== "linux") return;

  assert.equal(
    service.daemonSocketPathForUser("demo", {
      findSystemUser: () => ({ uid: 123 }),
      targetHomeForUser: () => "/home/demo",
    }),
    path.join("/run/user", "123", "rin-daemon", "daemon.sock"),
  );
  assert.equal(
    service.daemonSocketPathForUser("demo", {
      findSystemUser: () => ({ uid: -1 }),
      targetHomeForUser: () => "/home/demo",
    }),
    path.join("/home/demo", ".cache", "rin-daemon", "daemon.sock"),
  );
});
