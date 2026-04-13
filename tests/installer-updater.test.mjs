import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const updater = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "updater.js"))
    .href
);

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function createUpdaterHarness(overrides = {}) {
  const calls = [];
  const notes = [];
  const outros = [];
  const selects = [];
  const confirms = [];
  const finalized = [];
  const targets = overrides.targets ?? [];

  return {
    calls,
    notes,
    outros,
    selects,
    confirms,
    finalized,
    deps: {
      detectCurrentUser: () => overrides.currentUser ?? "rin",
      repoRootFromHere: () => overrides.repoRoot ?? "/repo",
      ensureNotCancelled: (value) => value,
      intro: (message) => calls.push(["intro", message]),
      note: (message, title) => notes.push([title, message]),
      outro: (message) => outros.push(message),
      select: async (options) => {
        selects.push(options);
        return overrides.selectedIndex ?? 0;
      },
      confirm: async (options) => {
        confirms.push(options);
        return overrides.confirmResult ?? true;
      },
      discoverInstalledTargets: () => targets,
      runFinalizeInstallPlanInChild: async (...args) => {
        finalized.push(args);
        return (
          overrides.finalizeResult ?? {
            written: {
              launcherPath: "/home/rin/.config/rin/install.json",
              rinPath: "/home/rin/.local/bin/rin",
              rinInstallPath: "/home/rin/.local/bin/rin-install",
            },
            publishedRuntime: {
              currentLink: "/srv/rin/app/current",
              releaseRoot: "/srv/rin/app/releases/release-1",
            },
            installedDocs: { pi: ["/srv/rin/docs/pi"] },
            installedDocsDir: "/srv/rin/docs/rin",
            installedService: {
              kind: "systemd",
              servicePath: "/home/rin/.config/systemd/user/rin-daemon.service",
              label: "rin-daemon.service",
            },
            daemonReady: true,
            serviceHint: "systemd user service ready",
            prunedReleases: { removed: ["old-1"] },
          }
        );
      },
    },
  };
}

test("installer updater exits cleanly when no installed targets are discovered", async () => {
  const harness = createUpdaterHarness();

  await updater.startUpdater(harness.deps);

  assert.deepEqual(harness.notes, [
    [
      "Update targets",
      "No installed Rin daemon targets were discovered on this system.",
    ],
  ]);
  assert.deepEqual(harness.outros, ["Nothing updated."]);
  assert.equal(harness.finalized.length, 0);
  assert.equal(harness.selects.length, 0);
  assert.equal(harness.confirms.length, 0);
});

test("installer updater uses the discovered target directly when only one install exists", async () => {
  const harness = createUpdaterHarness({
    currentUser: "rin",
    targets: [
      {
        targetUser: "rin",
        installDir: "/srv/rin",
        ownerHome: "/home/rin",
        source: "manifest",
      },
    ],
  });

  await updater.startUpdater(harness.deps);

  assert.equal(harness.selects.length, 0);
  assert.equal(harness.confirms.length, 1);
  assert.deepEqual(harness.finalized[0][0], {
    currentUser: "rin",
    targetUser: "rin",
    installDir: "/srv/rin",
    sourceRoot: "/repo",
  });
  assert.match(harness.notes[0][1], /Selected daemon user: rin/);
  assert.match(harness.notes[1][1], /Removed old releases: 1/);
  assert.match(harness.outros[0], /Updater refreshed rin at \/srv\/rin/);
});

test("installer updater lets overrides replace the selected target and preserves cross-user next-step hints", async () => {
  const harness = createUpdaterHarness({
    currentUser: "builder",
    selectedIndex: 1,
    targets: [
      {
        targetUser: "alpha",
        installDir: "/srv/alpha",
        ownerHome: "/home/alpha",
        source: "manifest",
      },
      {
        targetUser: "beta",
        installDir: "/srv/beta",
        ownerHome: "/home/beta",
        source: "systemd",
      },
    ],
    finalizeResult: {
      written: {
        launcherPath: "/home/builder/.config/rin/install.json",
        rinPath: "/home/builder/.local/bin/rin",
        rinInstallPath: "/home/builder/.local/bin/rin-install",
      },
      publishedRuntime: {
        currentLink: "/srv/override/app/current",
        releaseRoot: "/srv/override/app/releases/release-9",
      },
      installedDocs: { pi: [] },
      installedDocsDir: "",
      installedService: null,
      daemonReady: false,
      serviceHint: "manual start required",
      prunedReleases: { removed: [] },
    },
  });

  await withEnv(
    {
      RIN_UPDATE_TARGET_USER: "override-user",
      RIN_UPDATE_INSTALL_DIR: " /srv/override ",
    },
    async () => {
      await updater.startUpdater(harness.deps);
    },
  );

  assert.equal(harness.selects.length, 1);
  assert.equal(harness.selects[0].options[1].label, "beta → /srv/beta");
  assert.deepEqual(harness.finalized[0][0], {
    currentUser: "builder",
    targetUser: "override-user",
    installDir: "/srv/override",
    sourceRoot: "/repo",
  });
  assert.match(harness.notes[0][1], /Discovered from: systemd/);
  assert.match(harness.notes[0][1], /Owner home: \/home\/beta/);
  assert.match(harness.notes[1][1], /rin doctor -u override-user/);
  assert.match(harness.outros[0], /Use rin start -u override-user/);
});

test("installer updater stops cleanly when confirmation is declined", async () => {
  const harness = createUpdaterHarness({
    confirmResult: false,
    targets: [
      {
        targetUser: "rin",
        installDir: "/srv/rin",
        ownerHome: "/home/rin",
        source: "manifest",
      },
    ],
  });

  await updater.startUpdater(harness.deps);

  assert.equal(harness.finalized.length, 0);
  assert.deepEqual(harness.outros, [
    "Updater finished without writing changes.",
  ]);
});
