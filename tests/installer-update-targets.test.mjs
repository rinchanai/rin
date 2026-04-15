import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const updateTargets = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "update-targets.js"),
  ).href
);

function createDirent(name, isDirectory = true) {
  return {
    name,
    isDirectory: () => isDirectory,
  };
}

test("installer update target discovery prefers manifest and service sources over launcher metadata when they describe the same target", () => {
  const files = new Map([
    [
      "/workspace/home/alice/.config/rin/install.json",
      JSON.stringify({
        defaultTargetUser: "alice",
        defaultInstallDir: "/srv/rin-alice",
      }),
    ],
    [
      "/workspace/home/alice/.rin/installer.json",
      JSON.stringify({ targetUser: "alice", installDir: "/srv/rin-alice" }),
    ],
    [
      "/workspace/home/alice/.config/systemd/user/rin-daemon-alice.service",
      "[Service]\nEnvironment=RIN_DIR=/srv/rin-alice\n",
    ],
    [
      "/workspace/home/bob/.rin/config/installer.json",
      JSON.stringify({ installDir: "  /srv/rin-bob  " }),
    ],
    [
      "/workspace/home/bob/.config/systemd/user/rin-daemon.service",
      "[Service]\nExecStart=node daemon.js\n",
    ],
    [
      "/workspace/Users/carla/Library/LaunchAgents/com.rin.daemon.carla.plist",
      "<plist><key>RIN_DIR</key><string>/Users/carla/.rin-app</string></plist>",
    ],
  ]);

  const directories = new Map([
    ["/workspace/home", [createDirent("alice"), createDirent("bob")]],
    ["/workspace/Users", [createDirent("carla")]],
    [
      "/workspace/home/alice/.config/systemd/user",
      [
        createDirent("rin-daemon-alice.service", false),
        createDirent("not-rin.service", false),
      ],
    ],
    [
      "/workspace/home/bob/.config/systemd/user",
      [createDirent("rin-daemon.service", false)],
    ],
    [
      "/workspace/Users/carla/Library/LaunchAgents",
      [
        createDirent("com.rin.daemon.carla.plist", false),
        createDirent("ignore.txt", false),
      ],
    ],
  ]);

  const targets = updateTargets.discoverInstalledTargets({
    roots: ["/workspace/home", "/workspace/Users"],
    readdirSync(targetPath, options) {
      if (options?.withFileTypes) return directories.get(targetPath) ?? [];
      return (directories.get(targetPath) ?? []).map((entry) => entry.name);
    },
    readFileSync(targetPath) {
      if (!files.has(targetPath)) throw new Error(`ENOENT: ${targetPath}`);
      return files.get(targetPath);
    },
  });

  assert.deepEqual(targets, [
    {
      targetUser: "alice",
      installDir: "/srv/rin-alice",
      ownerHome: "/workspace/home/alice",
      source: "manifest",
    },
    {
      targetUser: "bob",
      installDir: "/srv/rin-bob",
      ownerHome: "/workspace/home/bob",
      source: "manifest",
    },
    {
      targetUser: "bob",
      installDir: "/workspace/home/bob/.rin",
      ownerHome: "/workspace/home/bob",
      source: "systemd",
    },
    {
      targetUser: "carla",
      installDir: "/Users/carla/.rin-app",
      ownerHome: "/workspace/Users/carla",
      source: "launchd",
    },
  ]);
});

test("installer update target discovery skips duplicates and malformed records", () => {
  const files = new Map([
    [
      "/workspace/home/demo/.config/rin/install.json",
      JSON.stringify({
        defaultTargetUser: " demo ",
        defaultInstallDir: " /srv/rin-demo ",
      }),
    ],
    [
      "/workspace/home/demo/.rin/installer.json",
      JSON.stringify({ targetUser: " demo ", installDir: " /srv/rin-demo " }),
    ],
    [
      "/workspace/home/demo/.config/systemd/user/rin-daemon.service",
      "[Service]\nEnvironment=RIN_DIR=/srv/rin-demo\n",
    ],
    [
      "/workspace/home/demo/.config/systemd/user/rin-daemon-extra.service",
      "[Service]\nEnvironment=RIN_DIR=   \n",
    ],
    [
      "/workspace/Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
      "<plist><key>RIN_DIR</key><string>   </string></plist>",
    ],
  ]);
  const directories = new Map([
    ["/workspace/home", [createDirent("demo")]],
    ["/workspace/Users", [createDirent("demo")]],
    [
      "/workspace/home/demo/.config/systemd/user",
      [
        createDirent("rin-daemon.service", false),
        createDirent("rin-daemon-extra.service", false),
      ],
    ],
    [
      "/workspace/Users/demo/Library/LaunchAgents",
      [createDirent("com.rin.daemon.demo.plist", false)],
    ],
  ]);

  const targets = updateTargets.discoverInstalledTargets({
    roots: ["/workspace/home", "/workspace/Users"],
    readdirSync(targetPath, options) {
      if (options?.withFileTypes) return directories.get(targetPath) ?? [];
      return (directories.get(targetPath) ?? []).map((entry) => entry.name);
    },
    readFileSync(targetPath) {
      if (!files.has(targetPath)) throw new Error(`ENOENT: ${targetPath}`);
      return files.get(targetPath);
    },
  });

  assert.deepEqual(targets, [
    {
      targetUser: "demo",
      installDir: "/srv/rin-demo",
      ownerHome: "/workspace/home/demo",
      source: "manifest",
    },
  ]);
});

test("installer update target discovery reads mac launcher metadata and ignores malformed launcher defaults", () => {
  const files = new Map([
    [
      "/workspace/Users/carla/Library/Application Support/rin/install.json",
      JSON.stringify({
        defaultTargetUser: "rinbot",
        defaultInstallDir: " /srv/rinbot ",
      }),
    ],
    [
      "/workspace/Users/dana/Library/Application Support/rin/install.json",
      JSON.stringify({ defaultTargetUser: "   ", defaultInstallDir: "   " }),
    ],
  ]);
  const directories = new Map([
    ["/workspace/Users", [createDirent("carla"), createDirent("dana")]],
  ]);

  const targets = updateTargets.discoverInstalledTargets({
    roots: ["/workspace/Users"],
    readdirSync(targetPath, options) {
      if (options?.withFileTypes) return directories.get(targetPath) ?? [];
      return (directories.get(targetPath) ?? []).map((entry) => entry.name);
    },
    readFileSync(targetPath) {
      if (!files.has(targetPath)) throw new Error(`ENOENT: ${targetPath}`);
      return files.get(targetPath);
    },
  });

  assert.deepEqual(targets, [
    {
      targetUser: "rinbot",
      installDir: "/srv/rinbot",
      ownerHome: "/workspace/Users/carla",
      source: "launcher",
    },
  ]);
});
