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

test("installer service helpers derive sanitized systemd unit names", () => {
  const context = service.systemdUserContext("demo user", {
    findSystemUser: () => ({ uid: 4242 }),
  });
  assert.deepEqual(context.units, [
    "rin-daemon-demo-user.service",
    "rin-daemon.service",
  ]);
});

test("installer service helpers derive daemon socket paths from uid or target home", () => {
  const withUid = service.daemonSocketPathForUser("demo", {
    findSystemUser: () => ({ uid: 1234 }),
    targetHomeForUser: () => "/home/demo",
  });
  assert.equal(
    withUid,
    path.join("/run/user", "1234", "rin-daemon", "daemon.sock"),
  );

  const withoutUid = service.daemonSocketPathForUser("demo", {
    findSystemUser: () => null,
    targetHomeForUser: () => "/home/demo",
  });
  assert.equal(
    withoutUid,
    path.join("/home/demo", ".cache", "rin-daemon", "daemon.sock"),
  );
});

test("installer service helpers detect a ready unix socket", async () => {
  const net = await import("node:net");
  const socketDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-install-socket-"),
  );
  const socketPath = path.join(socketDir, "daemon.sock");
  const server = net.createServer((socket) => {
    socket.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    assert.equal(await service.waitForSocket(socketPath, 1000), true);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(socketDir, { recursive: true, force: true });
  }
});

test("installer service helpers time out cleanly for a missing unix socket", async () => {
  const socketDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-install-missing-socket-"),
  );
  const socketPath = path.join(socketDir, "daemon.sock");
  try {
    assert.equal(await service.waitForSocket(socketPath, 150), false);
  } finally {
    await fs.rm(socketDir, { recursive: true, force: true });
  }
});

test("installer service helpers include core daemon failure context", () => {
  const currentUser = os.userInfo().username;
  const text = service.collectDaemonFailureDetails(currentUser, "/tmp/rin", {
    findSystemUser: () => null,
    targetHomeForUser: () => "/home/demo",
  });
  assert.match(text, new RegExp(`targetUser=${currentUser}`));
  assert.match(text, /installDir=\/tmp\/rin/);
  assert.match(text, /socketReady=no/);
  assert.match(text, /socketPath=.+rin-daemon[\\/]daemon\.sock/);
});
