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
const fsUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "fs-utils.js"),
  ).href
);

async function createPublishFixture() {
  const sourceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-install-src-"),
  );
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-install-dst-"),
  );

  await fs.mkdir(path.join(sourceRoot, "dist", "app", "rin"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(sourceRoot, "dist", "app", "rin", "main.js"),
    "export {};",
    "utf8",
  );
  await fs.mkdir(path.join(sourceRoot, "extensions", "demo"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(sourceRoot, "extensions", "demo", "index.js"),
    "export {};",
    "utf8",
  );
  await fs.writeFile(path.join(sourceRoot, "package.json"), "{\n}\n", "utf8");
  await fs.copyFile(
    path.join(rootDir, "tsconfig.base.json"),
    path.join(sourceRoot, "tsconfig.base.json"),
  );

  const vendorRoot = path.join(sourceRoot, "third_party", "pi-coding-agent");
  await fs.mkdir(path.dirname(vendorRoot), { recursive: true });
  await fs.cp(
    path.join(rootDir, "third_party", "pi-coding-agent", "src"),
    path.join(vendorRoot, "src"),
    {
      recursive: true,
    },
  );
  await fs.copyFile(
    path.join(rootDir, "third_party", "pi-coding-agent", "package.json"),
    path.join(vendorRoot, "package.json"),
  );
  await fs.copyFile(
    path.join(rootDir, "third_party", "pi-coding-agent", "tsconfig.build.json"),
    path.join(vendorRoot, "tsconfig.build.json"),
  );

  await fs.symlink(
    path.join(rootDir, "node_modules"),
    path.join(sourceRoot, "node_modules"),
  );

  return { sourceRoot, installDir };
}

async function addInstalledDocsFixture(sourceRoot) {
  await fs.mkdir(path.join(sourceRoot, "docs", "rin", "docs"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(sourceRoot, "docs", "rin", "README.md"),
    "# Rin runtime docs\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(sourceRoot, "docs", "rin", "docs", "capabilities.md"),
    "runtime capability docs\n",
    "utf8",
  );

  await fs.mkdir(
    path.join(sourceRoot, "third_party", "anthropics-skills", "skill-creator"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      sourceRoot,
      "third_party",
      "anthropics-skills",
      "skill-creator",
      "SKILL.md",
    ),
    "# skill creator\n",
    "utf8",
  );

  const piRoot = path.join(sourceRoot, "third_party", "pi-coding-agent");
  await fs.writeFile(path.join(piRoot, "README.md"), "# Pi\n", "utf8");
  await fs.writeFile(
    path.join(piRoot, "CHANGELOG.md"),
    "# Pi changelog\n",
    "utf8",
  );
  await fs.mkdir(path.join(piRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(piRoot, "docs", "guide.md"), "guide\n", "utf8");
  await fs.mkdir(path.join(piRoot, "examples"), { recursive: true });
  await fs.writeFile(
    path.join(piRoot, "examples", "demo.md"),
    "demo\n",
    "utf8",
  );
}

test("installer fs utils read and write local metadata with stable defaults", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rin-install-io-"));
  const jsonPath = path.join(tempRoot, "config", "installer.json");
  const textPath = path.join(tempRoot, "config", "note.txt");
  const execPath = path.join(tempRoot, "bin", "rin-demo");

  assert.deepEqual(fsUtils.readJsonFile(jsonPath, { ok: false }), {
    ok: false,
  });
  assert.deepEqual(fsUtils.readInstallerJson(jsonPath, { ok: false }), {
    ok: false,
  });

  fsUtils.writeJsonFile(jsonPath, { ok: true, nested: { count: 2 } });
  fsUtils.writeTextFile(textPath, "hello world\n", 0o640);
  fsUtils.writeExecutable(execPath, "#!/usr/bin/env sh\necho demo\n");

  assert.deepEqual(fsUtils.readJsonFile(jsonPath, null), {
    ok: true,
    nested: { count: 2 },
  });
  assert.deepEqual(fsUtils.readInstallerJson(jsonPath, null), {
    ok: true,
    nested: { count: 2 },
  });
  assert.equal(
    await fs.readFile(jsonPath, "utf8"),
    '{\n  "ok": true,\n  "nested": {\n    "count": 2\n  }\n}\n',
  );
  assert.equal(await fs.readFile(textPath, "utf8"), "hello world\n");
  assert.match(await fs.readFile(execPath, "utf8"), /echo demo/);

  const textMode = (await fs.stat(textPath)).mode & 0o777;
  const execMode = (await fs.stat(execPath)).mode & 0o777;
  assert.equal(textMode, 0o640);
  assert.equal(execMode, 0o755);
});

test("installer fs utils compute launcher targets and script", () => {
  const targets = fsUtils.launcherTargetsForInstallDir("/tmp/rin");
  assert.ok(
    targets.rin[0].endsWith(path.join("dist", "app", "rin", "main.js")),
  );
  assert.ok(
    targets.rinInstall[0].endsWith(
      path.join("dist", "app", "rin-install", "main.js"),
    ),
  );
  const script = fsUtils.launcherScript(["/tmp/a.js", "/tmp/b.js"]);
  assert.ok(script.includes("installed runtime entry not found"));
  assert.ok(script.includes("/tmp/a.js"));
});

test("writeLaunchersForUser and appConfigDirForUser use stable per-user install locations", async () => {
  const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rin-home-"));
  const homeForUser = (user) => path.join(homeRoot, user);
  await fs.mkdir(homeForUser("demo"), { recursive: true });

  const written = fsUtils.writeLaunchersForUser(
    "demo",
    "/srv/rin",
    homeForUser,
  );
  assert.equal(
    written.rinPath,
    path.join(homeForUser("demo"), ".local", "bin", "rin"),
  );
  assert.equal(
    written.rinInstallPath,
    path.join(homeForUser("demo"), ".local", "bin", "rin-install"),
  );

  const rinLauncher = await fs.readFile(written.rinPath, "utf8");
  const installLauncher = await fs.readFile(written.rinInstallPath, "utf8");
  assert.match(rinLauncher, /app\/current\/dist\/app\/rin\/main\.js/);
  assert.match(
    installLauncher,
    /app\/current\/dist\/app\/rin-install\/main\.js/,
  );
  assert.equal(
    fsUtils.appConfigDirForUser("demo", homeForUser).includes(".config/rin"),
    true,
  );
});

test("syncTree and syncInstalledDocTree replace old payloads and ignore missing sources", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-install-sync-"),
  );
  const sourceDir = path.join(tempRoot, "source");
  const destDir = path.join(tempRoot, "dest");
  await fs.mkdir(path.join(sourceDir, "nested"), { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, "nested", "new.txt"),
    "new\n",
    "utf8",
  );
  await fs.mkdir(path.join(destDir, "nested"), { recursive: true });
  await fs.writeFile(path.join(destDir, "nested", "old.txt"), "old\n", "utf8");

  fsUtils.syncTree(sourceDir, destDir);
  await fs.access(path.join(destDir, "nested", "new.txt"));
  await assert.rejects(fs.access(path.join(destDir, "nested", "old.txt")));

  const copiedDocRoot = path.join(tempRoot, "installed-docs");
  const synced = fsUtils.syncInstalledDocTree(
    sourceDir,
    copiedDocRoot,
    "rin",
    false,
    { findSystemUser: () => null },
  );
  assert.equal(synced, copiedDocRoot);
  await fs.access(path.join(copiedDocRoot, "nested", "new.txt"));

  assert.equal(
    fsUtils.syncInstalledDocTree(
      path.join(tempRoot, "missing"),
      path.join(tempRoot, "ignored"),
      "rin",
      false,
      { findSystemUser: () => null },
    ),
    null,
  );
});

test("publishInstalledRuntime rebuilds vendored coding-agent dist when missing", async () => {
  const { sourceRoot, installDir } = await createPublishFixture();

  const published = fsUtils.publishInstalledRuntime(
    sourceRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );

  await fs.access(
    path.join(
      published.releaseRoot,
      "third_party",
      "pi-coding-agent",
      "dist",
      "core",
      "session-manager.js",
    ),
  );
  await fs.access(
    path.join(
      published.releaseRoot,
      "third_party",
      "pi-coding-agent",
      "dist",
      "modes",
      "interactive",
      "theme",
      "dark.json",
    ),
  );
  await fs.access(
    path.join(published.releaseRoot, "extensions", "demo", "index.js"),
  );
  await fs.access(path.join(published.releaseRoot, "package.json"));

  const currentLink = await fs.readlink(
    path.join(installDir, "app", "current"),
  );
  assert.equal(currentLink, published.releaseRoot);
});

test("publishInstalledRuntime replaces the current symlink and pruneInstalledReleases keeps the newest entries plus the active release", async () => {
  const { sourceRoot, installDir } = await createPublishFixture();

  const first = fsUtils.publishInstalledRuntime(
    sourceRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );
  await fs.writeFile(
    path.join(sourceRoot, "package.json"),
    '{"name":"rin-v2"}\n',
    "utf8",
  );
  const second = fsUtils.publishInstalledRuntime(
    sourceRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );

  const currentLink = await fs.readlink(second.currentLink);
  assert.equal(currentLink, second.releaseRoot);
  assert.notEqual(first.releaseRoot, second.releaseRoot);

  const releasesDir = path.join(installDir, "app", "releases");
  await fs.mkdir(path.join(releasesDir, "2026-01-01T00-00-00-000Z"), {
    recursive: true,
  });
  await fs.mkdir(path.join(releasesDir, "2026-01-02T00-00-00-000Z"), {
    recursive: true,
  });
  await fs.mkdir(path.join(releasesDir, "2026-01-03T00-00-00-000Z"), {
    recursive: true,
  });

  const listed = fsUtils.listInstalledReleaseNames(installDir);
  assert.ok(listed.includes(path.basename(first.releaseRoot)));
  assert.ok(listed.includes(path.basename(second.releaseRoot)));

  const pruned = fsUtils.pruneInstalledReleases(
    installDir,
    2,
    first.releaseRoot,
  );
  assert.equal(pruned.keepCount, 2);
  assert.ok(pruned.kept.includes(path.basename(first.releaseRoot)));
  assert.ok(pruned.kept.includes(path.basename(second.releaseRoot)));
  assert.equal(
    pruned.removed.some((entry) => entry.endsWith("2026-01-01T00-00-00-000Z")),
    true,
  );
  assert.equal(
    pruned.removed.some((entry) => entry.endsWith("2026-01-02T00-00-00-000Z")),
    true,
  );
  assert.equal(
    pruned.removed.some((entry) => entry.endsWith("2026-01-03T00-00-00-000Z")),
    true,
  );
  assert.deepEqual(
    fsUtils.listInstalledReleaseNames(installDir).sort(),
    [
      path.basename(first.releaseRoot),
      path.basename(second.releaseRoot),
    ].sort(),
  );
});

test("syncInstalledDocs copies Rin runtime docs, builtin skills, and bundled Pi docs into stable install locations", async () => {
  const { sourceRoot, installDir } = await createPublishFixture();
  await addInstalledDocsFixture(sourceRoot);

  const installed = fsUtils.syncInstalledDocs(
    sourceRoot,
    installDir,
    "rin",
    false,
    {
      findSystemUser: () => null,
    },
  );

  assert.equal(installed.rin, path.join(installDir, "docs", "rin"));
  assert.deepEqual(installed.pi, [
    path.join(installDir, "docs", "pi", "README.md"),
    path.join(installDir, "docs", "pi", "CHANGELOG.md"),
    path.join(installDir, "docs", "pi", "docs"),
    path.join(installDir, "docs", "pi", "examples"),
  ]);
  await fs.access(path.join(installDir, "docs", "rin", "README.md"));
  await fs.access(
    path.join(installDir, "docs", "rin", "docs", "capabilities.md"),
  );
  await fs.access(
    path.join(
      installDir,
      "docs",
      "rin",
      "builtin-skills",
      "skill-creator",
      "SKILL.md",
    ),
  );
  await fs.access(path.join(installDir, "docs", "pi", "README.md"));
  await fs.access(path.join(installDir, "docs", "pi", "docs", "guide.md"));
  await fs.access(path.join(installDir, "docs", "pi", "examples", "demo.md"));
});

test("releaseIdNow emits a filesystem-safe UTC release id", () => {
  const releaseId = fsUtils.releaseIdNow();
  assert.match(releaseId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.equal(releaseId.includes(":"), false);
  assert.equal(releaseId.includes("."), false);
});
