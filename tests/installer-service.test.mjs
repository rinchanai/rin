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

test("installer service helpers capture target-user commands through runuser sudo and generic privilege commands", () => {
  const rootCalls = [];
  const sudoCalls = [];
  const genericCalls = [];

  const rootResult = service.captureCommandAsUser(
    "demo",
    "node",
    ["script.js", "--flag"],
    { RIN_MODE: "install" },
    {
      getuid: () => 0,
      existsSync: (filePath) => filePath === "/usr/sbin/runuser",
      execFileSync: (command, args, options) => {
        rootCalls.push([command, args, options]);
        return "ok-root";
      },
    },
  );
  const sudoResult = service.captureCommandAsUser(
    "demo",
    "node",
    ["script.js"],
    { RIN_MODE: "install" },
    {
      getuid: () => 1000,
      existsSync: () => false,
      pickPrivilegeCommand: () => "sudo",
      execFileSync: (command, args, options) => {
        sudoCalls.push([command, args, options]);
        return "ok-sudo";
      },
    },
  );
  const genericResult = service.captureCommandAsUser(
    "demo",
    "node",
    ["script.js"],
    { RIN_MODE: "install" },
    {
      getuid: () => 1000,
      existsSync: () => false,
      pickPrivilegeCommand: () => "su",
      execFileSync: (command, args, options) => {
        genericCalls.push([command, args, options]);
        return "ok-generic";
      },
    },
  );

  assert.equal(rootResult, "ok-root");
  assert.equal(sudoResult, "ok-sudo");
  assert.equal(genericResult, "ok-generic");
  assert.deepEqual(rootCalls[0], [
    "/usr/sbin/runuser",
    [
      "-u",
      "demo",
      "--",
      "sh",
      "-lc",
      'RIN_MODE="install" "node" "script.js" "--flag"',
    ],
    { encoding: "utf8" },
  ]);
  assert.deepEqual(sudoCalls[0], [
    "sudo",
    ["-u", "demo", "sh", "-lc", 'RIN_MODE="install" "node" "script.js"'],
    { encoding: "utf8" },
  ]);
  assert.deepEqual(genericCalls[0], [
    "su",
    ["sh", "-lc", 'RIN_MODE="install" "node" "script.js"'],
    { encoding: "utf8" },
  ]);
});

test("installer service helpers install launchd agents through local and elevated command paths", () => {
  const elevatedCalls = [];
  const localCalls = [];
  const elevated = service.installLaunchdAgent("demo user", "/tmp/rin", true, {
    findSystemUser: () => ({ uid: 4242, gid: 1234 }),
    targetHomeForUser: () => "/Users/demo",
    repoRootFromHere: () => "/repo",
    runPrivileged: (command, args) => {
      elevatedCalls.push(["priv", command, args]);
    },
    writeTextFileWithPrivilege: (
      filePath,
      content,
      ownerUser,
      ownerGroup,
      mode,
    ) => {
      elevatedCalls.push([
        "write-priv",
        filePath,
        ownerUser,
        ownerGroup,
        mode,
        content.includes("com.rin.daemon.demo-user"),
      ]);
    },
  });
  const local = service.installLaunchdAgent("demo user", "/tmp/rin", false, {
    findSystemUser: () => ({ uid: 4242, gid: 1234 }),
    targetHomeForUser: () => "/Users/demo",
    repoRootFromHere: () => "/repo",
    ensureDir: (dir) => {
      localCalls.push(["mkdir", dir]);
    },
    writeTextFile: (filePath, content, mode) => {
      localCalls.push([
        "write",
        filePath,
        mode,
        content.includes("/repo/dist/app/rin-daemon/daemon.js"),
      ]);
    },
    execFileSync: (command, args, options) => {
      localCalls.push([command, args, options]);
      return "";
    },
  });

  assert.equal(elevated.label, "com.rin.daemon.demo-user");
  assert.equal(local.label, "com.rin.daemon.demo-user");
  assert.deepEqual(elevatedCalls, [
    ["priv", "mkdir", ["-p", "/Users/demo/Library/LaunchAgents"]],
    ["priv", "mkdir", ["-p", "/tmp/rin/data/logs"]],
    [
      "write-priv",
      "/Users/demo/Library/LaunchAgents/com.rin.daemon.demo-user.plist",
      "demo user",
      1234,
      420,
      true,
    ],
    [
      "priv",
      "launchctl",
      [
        "bootout",
        "gui/4242",
        "/Users/demo/Library/LaunchAgents/com.rin.daemon.demo-user.plist",
      ],
    ],
    [
      "priv",
      "launchctl",
      [
        "bootstrap",
        "gui/4242",
        "/Users/demo/Library/LaunchAgents/com.rin.daemon.demo-user.plist",
      ],
    ],
    [
      "priv",
      "launchctl",
      ["kickstart", "-k", "gui/4242/com.rin.daemon.demo-user"],
    ],
  ]);
  assert.deepEqual(localCalls, [
    ["mkdir", "/Users/demo/Library/LaunchAgents"],
    ["mkdir", "/tmp/rin/data/logs"],
    [
      "write",
      "/Users/demo/Library/LaunchAgents/com.rin.daemon.demo-user.plist",
      420,
      true,
    ],
    [
      "launchctl",
      [
        "bootout",
        "gui/4242",
        "/Users/demo/Library/LaunchAgents/com.rin.daemon.demo-user.plist",
      ],
      { stdio: "ignore" },
    ],
    [
      "launchctl",
      [
        "bootstrap",
        "gui/4242",
        "/Users/demo/Library/LaunchAgents/com.rin.daemon.demo-user.plist",
      ],
      { stdio: "inherit" },
    ],
    [
      "launchctl",
      ["kickstart", "-k", "gui/4242/com.rin.daemon.demo-user"],
      { stdio: "inherit" },
    ],
  ]);
});

test("installer service helpers install and refresh systemd user units through local and elevated paths", () => {
  const elevatedCalls = [];
  const localCalls = [];
  const serviceSpec = service.installSystemdUserService(
    "demo user",
    "/tmp/rin",
    true,
    {
      findSystemUser: () => ({ uid: 4242, gid: 1234 }),
      targetHomeForUser: () => "/home/demo",
      repoRootFromHere: () => "/repo",
      existsSync: (filePath) =>
        filePath === "/usr/bin/systemctl" ||
        filePath === "/usr/bin/loginctl" ||
        filePath === "/run/user/4242",
      writeTextFileWithPrivilege: (
        filePath,
        content,
        ownerUser,
        ownerGroup,
        mode,
      ) => {
        elevatedCalls.push([
          "write-priv",
          filePath,
          ownerUser,
          ownerGroup,
          mode,
          content.includes("ExecStart="),
        ]);
      },
      runPrivileged: (command, args) => {
        elevatedCalls.push(["priv", command, args]);
      },
      runCommandAsUser: (targetUser, command, args, extraEnv) => {
        elevatedCalls.push(["as-user", targetUser, command, args, extraEnv]);
      },
    },
  );
  service.installSystemdUserService("demo user", "/tmp/rin", false, {
    findSystemUser: () => ({ uid: 4242, gid: 1234 }),
    targetHomeForUser: () => "/home/demo",
    repoRootFromHere: () => "/repo",
    existsSync: (filePath) =>
      filePath === "/usr/bin/systemctl" || filePath === "/run/user/4242",
    writeTextFile: (filePath, content, mode) => {
      localCalls.push([
        "write",
        filePath,
        mode,
        content.includes("WorkingDirectory=/home/demo"),
      ]);
    },
    execFileSync: (command, args, options) => {
      localCalls.push([command, args, options]);
      return "";
    },
  });
  service.refreshManagedServiceFiles("demo user", "/tmp/rin-next", true, {
    findSystemUser: () => ({ gid: 1234 }),
    targetHomeForUser: () => "/home/demo",
    repoRootFromHere: () => "/repo",
    existsSync: (filePath) =>
      filePath.endsWith("rin-daemon-demo-user.service") ||
      filePath.endsWith("rin-daemon.service"),
    writeTextFileWithPrivilege: (
      filePath,
      content,
      ownerUser,
      ownerGroup,
      mode,
    ) => {
      elevatedCalls.push([
        "refresh-priv",
        filePath,
        ownerUser,
        ownerGroup,
        mode,
        content.includes("RIN_DIR=/tmp/rin-next"),
      ]);
    },
  });
  service.refreshManagedServiceFiles("demo user", "/tmp/rin-next", false, {
    findSystemUser: () => ({ gid: 1234 }),
    targetHomeForUser: () => "/home/demo",
    repoRootFromHere: () => "/repo",
    existsSync: (filePath) => filePath.endsWith("rin-daemon.service"),
    writeTextFile: (filePath, content, mode) => {
      localCalls.push([
        "refresh",
        filePath,
        mode,
        content.includes("RIN_DIR=/tmp/rin-next"),
      ]);
    },
  });

  assert.equal(serviceSpec.label, "rin-daemon-demo-user.service");
  assert.deepEqual(elevatedCalls.slice(0, 4), [
    [
      "write-priv",
      "/home/demo/.config/systemd/user/rin-daemon-demo-user.service",
      "demo user",
      1234,
      420,
      true,
    ],
    ["priv", "/usr/bin/loginctl", ["enable-linger", "demo user"]],
    [
      "as-user",
      "demo user",
      "/usr/bin/systemctl",
      ["--user", "daemon-reload"],
      {
        XDG_RUNTIME_DIR: "/run/user/4242",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/4242/bus",
      },
    ],
    [
      "as-user",
      "demo user",
      "/usr/bin/systemctl",
      ["--user", "enable", "--now", "rin-daemon-demo-user.service"],
      {
        XDG_RUNTIME_DIR: "/run/user/4242",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/4242/bus",
      },
    ],
  ]);
  assert.deepEqual(localCalls.slice(0, 3), [
    [
      "write",
      "/home/demo/.config/systemd/user/rin-daemon-demo-user.service",
      420,
      true,
    ],
    [
      "/usr/bin/systemctl",
      ["--user", "daemon-reload"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: "/run/user/4242",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/4242/bus",
        },
      },
    ],
    [
      "/usr/bin/systemctl",
      ["--user", "enable", "--now", "rin-daemon-demo-user.service"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: "/run/user/4242",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/4242/bus",
        },
      },
    ],
  ]);
  assert.equal(
    elevatedCalls.filter((entry) => entry[0] === "refresh-priv").length,
    2,
  );
  assert.deepEqual(localCalls.at(-1), [
    "refresh",
    "/home/demo/.config/systemd/user/rin-daemon.service",
    420,
    true,
  ]);
});

test("installer service helpers reconcile systemd units through local and elevated command paths", () => {
  const elevatedCalls = [];
  const localCalls = [];
  const elevatedOk = service.reconcileSystemdUserService(
    "demo",
    "/tmp/rin",
    "restart",
    true,
    {
      findSystemUser: () => ({ uid: 4242 }),
      systemdUserContext: () => ({
        systemctl: "/usr/bin/systemctl",
        userEnv: { XDG_RUNTIME_DIR: "/run/user/4242" },
        units: ["rin-daemon-demo.service", "rin-daemon.service"],
      }),
      runCommandAsUser: (targetUser, command, args, extraEnv) => {
        elevatedCalls.push([targetUser, command, args, extraEnv]);
        if (args[2] === "rin-daemon-demo.service") throw new Error("miss");
      },
    },
  );
  const localOk = service.reconcileSystemdUserService(
    "demo",
    "/tmp/rin",
    "start",
    false,
    {
      findSystemUser: () => ({ uid: 4242 }),
      systemdUserContext: () => ({
        systemctl: "/usr/bin/systemctl",
        userEnv: { XDG_RUNTIME_DIR: "/run/user/4242" },
        units: ["rin-daemon-demo.service"],
      }),
      execFileSync: (command, args, options) => {
        localCalls.push([command, args, options]);
        return "";
      },
    },
  );
  const noSystemctl = service.reconcileSystemdUserService(
    "demo",
    "/tmp/rin",
    "start",
    false,
    {
      findSystemUser: () => ({ uid: 4242 }),
      systemdUserContext: () => ({ systemctl: "", userEnv: {}, units: [] }),
    },
  );

  assert.equal(elevatedOk, true);
  assert.equal(localOk, true);
  assert.equal(noSystemctl, false);
  assert.deepEqual(elevatedCalls, [
    [
      "demo",
      "/usr/bin/systemctl",
      ["--user", "daemon-reload"],
      { XDG_RUNTIME_DIR: "/run/user/4242" },
    ],
    [
      "demo",
      "/usr/bin/systemctl",
      ["--user", "restart", "rin-daemon-demo.service"],
      { XDG_RUNTIME_DIR: "/run/user/4242" },
    ],
    [
      "demo",
      "/usr/bin/systemctl",
      ["--user", "restart", "rin-daemon.service"],
      { XDG_RUNTIME_DIR: "/run/user/4242" },
    ],
  ]);
  assert.deepEqual(localCalls, [
    [
      "/usr/bin/systemctl",
      ["--user", "daemon-reload"],
      {
        stdio: "inherit",
        env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/4242" },
      },
    ],
    [
      "/usr/bin/systemctl",
      ["--user", "start", "rin-daemon-demo.service"],
      {
        stdio: "inherit",
        env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/4242" },
      },
    ],
  ]);
});

test("installer service helpers route installDaemonService through the platform-specific installer", () => {
  if (process.platform === "linux") {
    const calls = [];
    const result = service.installDaemonService("demo", "/tmp/rin", true, {
      findSystemUser: () => ({ uid: 4242, gid: 1234 }),
      targetHomeForUser: () => "/home/demo",
      repoRootFromHere: () => "/repo",
      existsSync: (filePath) => filePath === "/usr/bin/systemctl",
      refreshManagedServiceFiles: (targetUser, installDir, elevated, deps) => {
        calls.push([
          "refresh",
          targetUser,
          installDir,
          elevated,
          typeof deps.findSystemUser,
        ]);
      },
      installSystemdUserService: (targetUser, installDir, elevated, deps) => {
        calls.push([
          "install",
          targetUser,
          installDir,
          elevated,
          typeof deps.findSystemUser,
        ]);
        return { kind: "systemd", label: "rin-daemon-demo.service" };
      },
    });
    assert.deepEqual(result, {
      kind: "systemd",
      label: "rin-daemon-demo.service",
    });
    assert.deepEqual(calls, [
      ["refresh", "demo", "/tmp/rin", true, "function"],
      ["install", "demo", "/tmp/rin", true, "function"],
    ]);
    return;
  }

  if (process.platform === "darwin") {
    const calls = [];
    const result = service.installDaemonService("demo", "/tmp/rin", true, {
      findSystemUser: () => ({ uid: 4242, gid: 1234 }),
      targetHomeForUser: () => "/Users/demo",
      repoRootFromHere: () => "/repo",
      installLaunchdAgent: (targetUser, installDir, elevated, deps) => {
        calls.push([
          targetUser,
          installDir,
          elevated,
          typeof deps.findSystemUser,
        ]);
        return { kind: "launchd", label: "com.rin.daemon.demo" };
      },
    });
    assert.deepEqual(result, {
      kind: "launchd",
      label: "com.rin.daemon.demo",
    });
    assert.deepEqual(calls, [["demo", "/tmp/rin", true, "function"]]);
    return;
  }

  assert.throws(
    () =>
      service.installDaemonService("demo", "/tmp/rin", false, {
        findSystemUser: () => ({ uid: 4242 }),
        targetHomeForUser: () => "/home/demo",
        repoRootFromHere: () => "/repo",
        existsSync: () => false,
      }),
    /rin_service_install_unsupported/,
  );
});

test("installer service helpers wait for sockets through direct and delegated target-user probes", async () => {
  const remoteCalls = [];
  const remoteOk = await service.waitForSocket("/tmp/demo.sock", 20, "demo", {
    currentUser: () => "owner",
    captureCommandAsUser: (targetUser, command, args) => {
      remoteCalls.push([targetUser, command, args]);
      return "ok";
    },
    sleep: async () => {},
  });
  assert.equal(remoteOk, true);
  assert.equal(remoteCalls[0][0], "demo");
  assert.equal(remoteCalls[0][1], process.execPath);
  assert.equal(remoteCalls[0][2][0], "-e");

  const localSocket = {
    once(event, handler) {
      if (event === "connect") setImmediate(handler);
      return this;
    },
    destroy() {},
  };
  const localOk = await service.waitForSocket("/tmp/demo.sock", 20, undefined, {
    createConnection: () => localSocket,
    sleep: async () => {},
  });
  assert.equal(localOk, true);

  const remoteFail = await service.waitForSocket("/tmp/demo.sock", 20, "demo", {
    currentUser: () => "owner",
    captureCommandAsUser: () => {
      throw new Error("nope");
    },
    sleep: async () => {},
  });
  assert.equal(remoteFail, false);
});
