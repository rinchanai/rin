import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const metadata = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "metadata.js"),
  ).href
);

test("installer metadata readers prefer primary paths and fall back to legacy locations", () => {
  const seen = [];
  const readJsonFile = (filePath, fallback) => {
    seen.push(filePath);
    if (filePath.endsWith(path.join(".config", "rin", "install.json"))) {
      return fallback;
    }
    if (
      filePath.endsWith(
        path.join("Library", "Application Support", "rin", "install.json"),
      )
    ) {
      return { defaultTargetUser: "carla" };
    }
    if (filePath.endsWith(path.join(".rin", "installer.json"))) {
      return fallback;
    }
    if (filePath.endsWith(path.join(".rin", "config", "installer.json"))) {
      return { targetUser: "legacy", installDir: "/srv/legacy" };
    }
    return fallback;
  };

  assert.deepEqual(
    metadata.readLauncherMetadataFromHome("/Users/carla", readJsonFile, null),
    { defaultTargetUser: "carla" },
  );
  assert.deepEqual(
    metadata.readInstallerManifestFromHome("/home/demo", readJsonFile, null),
    { targetUser: "legacy", installDir: "/srv/legacy" },
  );
  assert.deepEqual(seen, [
    path.join("/Users/carla", ".config", "rin", "install.json"),
    path.join(
      "/Users/carla",
      "Library",
      "Application Support",
      "rin",
      "install.json",
    ),
    path.join("/home/demo", ".rin", "installer.json"),
    path.join("/home/demo", ".rin", "config", "installer.json"),
  ]);
});

test("installer metadata normalizes launcher and manifest targets with stable defaults", () => {
  assert.deepEqual(
    metadata.installedTargetFromLauncherMetadata(
      {
        defaultTargetUser: " demo ",
        defaultInstallDir: " /srv/rin-demo ",
      },
      "ignored",
      "/home/demo",
    ),
    { targetUser: "demo", installDir: "/srv/rin-demo" },
  );
  assert.deepEqual(
    metadata.installedTargetFromLauncherMetadata({}, "demo", "/home/demo"),
    { targetUser: "demo", installDir: "/home/demo/.rin" },
  );
  assert.equal(
    metadata.installedTargetFromLauncherMetadata(
      {
        defaultTargetUser: "   ",
        defaultInstallDir: " /srv/rin-demo ",
      },
      "demo",
      "/home/demo",
    ),
    null,
  );
  assert.equal(
    metadata.installedTargetFromLauncherMetadata(
      {
        defaultTargetUser: "demo",
        defaultInstallDir: "   ",
      },
      "demo",
      "/home/demo",
    ),
    null,
  );
  assert.deepEqual(
    metadata.installedTargetFromManifest(
      { targetUser: " rinbot ", installDir: " /srv/rinbot " },
      "ignored",
      "/Users/rinbot",
    ),
    { targetUser: "rinbot", installDir: "/srv/rinbot" },
  );
  assert.deepEqual(
    metadata.installedTargetFromManifest({}, "carla", "/Users/carla"),
    { targetUser: "carla", installDir: "/Users/carla/.rin" },
  );
  assert.equal(
    metadata.installedTargetFromManifest(
      { targetUser: "   ", installDir: "/srv/rinbot" },
      "carla",
      "/Users/carla",
    ),
    null,
  );
  assert.equal(
    metadata.installedTargetFromManifest(
      { targetUser: "carla", installDir: "   " },
      "carla",
      "/Users/carla",
    ),
    null,
  );
});

test("installer metadata merges launcher defaults without dropping unrelated fields", () => {
  const next = metadata.nextLauncherMetadata(
    { theme: "dark", defaultTargetUser: "old" },
    {
      currentUser: "builder",
      targetUser: "demo",
      installDir: "/srv/rin",
      updatedAt: "2026-04-16T00:00:00.000Z",
    },
  );

  assert.deepEqual(next, {
    theme: "dark",
    defaultTargetUser: "demo",
    defaultInstallDir: "/srv/rin",
    updatedAt: "2026-04-16T00:00:00.000Z",
    installedBy: "builder",
  });
});
