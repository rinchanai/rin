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
const updateTargets = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "update-targets.js"),
  ).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-targets-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("discoverInstalledTargets scans manifest, systemd, and launchd homes deterministically", async () => {
  await withTempDir(async (dir) => {
    const homeRoot = path.join(dir, "home");
    const usersRoot = path.join(dir, "Users");
    const aliceHome = path.join(homeRoot, "alice");
    const bobHome = path.join(homeRoot, "bob");
    const carolHome = path.join(usersRoot, "carol");
    const danaHome = path.join(homeRoot, "dana");
    const eveHome = path.join(homeRoot, "eve");
    const frankHome = path.join(homeRoot, "frank");

    await fs.mkdir(path.join(aliceHome, ".rin"), { recursive: true });
    await fs.writeFile(
      path.join(aliceHome, ".rin", "installer.json"),
      JSON.stringify({
        targetUser: "alice",
        installDir: "/srv/rin-alice",
      }),
      "utf8",
    );
    await fs.mkdir(path.join(aliceHome, ".config", "systemd", "user"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        aliceHome,
        ".config",
        "systemd",
        "user",
        "rin-daemon-alice.service",
      ),
      "Environment=RIN_DIR=/srv/rin-alice\n",
      "utf8",
    );

    await fs.mkdir(path.join(bobHome, ".rin", "config"), { recursive: true });
    await fs.writeFile(
      path.join(bobHome, ".rin", "config", "installer.json"),
      JSON.stringify({ targetUser: "bob" }),
      "utf8",
    );

    await fs.mkdir(path.join(carolHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        carolHome,
        "Library",
        "LaunchAgents",
        "com.rin.daemon.carol.plist",
      ),
      [
        "<plist>",
        "  <dict>",
        "    <key>RIN_DIR</key>",
        "    <string>/Users/carol/.rin-managed</string>",
        "  </dict>",
        "</plist>",
      ].join("\n"),
      "utf8",
    );

    await fs.mkdir(path.join(danaHome, ".config", "systemd", "user"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(danaHome, ".config", "systemd", "user", "rin-daemon.service"),
      `Environment=RIN_DIR=${path.join(danaHome, ".rin")}\nExecStart=node daemon.js\n`,
      "utf8",
    );

    await fs.mkdir(path.join(eveHome, ".rin"), { recursive: true });
    await fs.writeFile(
      path.join(eveHome, ".rin", "installer.json"),
      JSON.stringify({
        targetUser: "eve",
        installDir: "/opt/rin-eve",
      }),
      "utf8",
    );

    await fs.mkdir(path.join(frankHome, ".config", "rin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(frankHome, ".config", "rin", "install.json"),
      JSON.stringify({
        defaultTargetUser: "frank-daemon",
        defaultInstallDir: "/opt/rin-frank",
      }),
      "utf8",
    );

    const discovered = updateTargets.discoverInstalledTargets([
      homeRoot,
      usersRoot,
    ]);

    assert.deepEqual(discovered, [
      {
        targetUser: "alice",
        installDir: "/srv/rin-alice",
        ownerHome: aliceHome,
        source: "manifest",
      },
      {
        targetUser: "bob",
        installDir: path.join(bobHome, ".rin"),
        ownerHome: bobHome,
        source: "manifest",
      },
      {
        targetUser: "carol",
        installDir: "/Users/carol/.rin-managed",
        ownerHome: carolHome,
        source: "launchd",
      },
      {
        targetUser: "dana",
        installDir: path.join(danaHome, ".rin"),
        ownerHome: danaHome,
        source: "systemd",
      },
      {
        targetUser: "eve",
        installDir: "/opt/rin-eve",
        ownerHome: eveHome,
        source: "manifest",
      },
      {
        targetUser: "frank-daemon",
        installDir: "/opt/rin-frank",
        ownerHome: frankHome,
        source: "launcher",
      },
    ]);
  });
});
