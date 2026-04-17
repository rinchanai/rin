import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
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
const tempBaseDir = "/home/rin/tmp";

test("installer fs utils compute launcher targets and script", () => {
  const targets = fsUtils.launcherTargetsForInstallDir("/tmp/rin");
  assert.ok(
    targets.rin[0].endsWith(path.join("dist", "app", "rin", "main.js")),
  );
  const script = fsUtils.launcherScript(["/tmp/a.js", "/tmp/b.js"]);
  assert.ok(script.includes("installed runtime entry not found"));
  assert.ok(script.includes("/tmp/a.js"));
  assert.ok(script.includes("PATH="));
  assert.ok(script.includes("'/usr/bin/env' 'node' '/tmp/a.js' \"$@\""));
  assert.equal(script.includes(process.execPath), false);
});

test("syncInstalledDocs copies upstream mirrors into installed doc locations", async () => {
  const tempRoot = await fs.mkdtemp(path.join(tempBaseDir, "rin-install-src-"));
  const installDir = await fs.mkdtemp(
    path.join(tempBaseDir, "rin-install-dst-"),
  );

  await fs.mkdir(path.join(tempRoot, "docs", "rin"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "docs", "rin", "README.md"),
    "# Rin docs\n",
    "utf8",
  );
  await fs.mkdir(path.join(tempRoot, "upstream", "pi", "docs"), {
    recursive: true,
  });
  await fs.mkdir(path.join(tempRoot, "upstream", "pi", "examples"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(tempRoot, "upstream", "pi", "README.md"),
    "# Pi docs\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "upstream", "pi", "CHANGELOG.md"),
    "# Changelog\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "upstream", "pi", "docs", "models.md"),
    "# Models\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "upstream", "pi", "examples", "README.md"),
    "# Examples\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "upstream", "pi", "_upstream.json"),
    "{}\n",
    "utf8",
  );
  await fs.mkdir(path.join(tempRoot, "upstream", "skill-creator"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(tempRoot, "upstream", "skill-creator", "SKILL.md"),
    "# Skill\n",
    "utf8",
  );

  const installedDocs = fsUtils.syncInstalledDocs(
    tempRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );

  assert.equal(installedDocs.pi.length, 5);
  await fs.access(path.join(installDir, "docs", "pi", "README.md"));
  await fs.access(path.join(installDir, "docs", "pi", "CHANGELOG.md"));
  await fs.access(path.join(installDir, "docs", "pi", "docs", "models.md"));
  await fs.access(path.join(installDir, "docs", "pi", "examples", "README.md"));
  await fs.access(path.join(installDir, "docs", "pi", "_upstream.json"));
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
});

test("publishInstalledRuntime no longer requires vendored pi-coding-agent sources", async () => {
  const tempRoot = await fs.mkdtemp(path.join(tempBaseDir, "rin-install-src-"));
  const installDir = await fs.mkdtemp(
    path.join(tempBaseDir, "rin-install-dst-"),
  );

  await fs.mkdir(path.join(tempRoot, "dist", "app", "rin"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(tempRoot, "dist", "app", "rin", "main.js"),
    "export {};",
    "utf8",
  );
  await fs.writeFile(path.join(tempRoot, "package.json"), "{\n}\n", "utf8");
  await fs.symlink(
    path.join(rootDir, "node_modules"),
    path.join(tempRoot, "node_modules"),
  );
  const published = fsUtils.publishInstalledRuntime(
    tempRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );

  await fs.access(
    path.join(published.releaseRoot, "dist", "app", "rin", "main.js"),
  );
  await fs.access(path.join(published.releaseRoot, "package.json"));
  await assert.rejects(
    fs.access(path.join(published.releaseRoot, "third_party")),
  );
});
