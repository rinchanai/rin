import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
);
const installScript = fs.readFileSync(path.join(rootDir, "install.sh"), "utf8");
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href
);

const publicReadmes = [
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.es.md",
  "README.fr.md",
].map((name) => ({
  name,
  filePath: path.join(rootDir, name),
  content: fs.readFileSync(path.join(rootDir, name), "utf8"),
}));

function markdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(
    (match) => match[1],
  );
}

test("package manifest bin entries point at built app entrypoints and stay executable after build", () => {
  const binEntries = Object.entries(packageJson.bin || {});
  assert.deepEqual(
    binEntries.map(([name]) => name),
    ["rin", "rin-daemon", "rin-tui", "rin-koishi", "rin-install"],
  );

  for (const [, relativePath] of binEntries) {
    const absolutePath = path.join(rootDir, String(relativePath));
    const stat = fs.statSync(absolutePath);
    assert.equal(stat.isFile(), true, absolutePath);
    assert.ok(
      (stat.mode & 0o111) !== 0,
      `expected executable bit on ${relativePath}`,
    );
    assert.match(
      String(relativePath),
      /^dist\/app\/.+\/main\.js$|^dist\/app\/rin-daemon\/daemon\.js$/,
    );
    assert.ok(packageJson.scripts.build.includes(String(relativePath)));
  }
});

test("bootstrap and in-runtime update sources both track the active repository", () => {
  assert.match(
    installScript,
    /REPO_URL=\$\{RIN_INSTALL_REPO_URL:-https:\/\/github\.com\/rinchanai\/rin\}/,
  );
  assert.equal(
    shared.DEFAULT_SOURCE_ARCHIVE_URL,
    "https://github.com/rinchanai/rin/archive/refs/heads/main.tar.gz",
  );
  assert.match(
    installScript,
    /ARCHIVE_URL="\$REPO_URL\/archive\/refs\/heads\/main\.tar\.gz"/,
  );
  assert.equal(shared.sourceArchiveUrl(), shared.DEFAULT_SOURCE_ARCHIVE_URL);
});

test("public readmes keep the same operator-facing command surface and only link to existing docs", () => {
  const requiredSnippets = [
    "./install.sh",
    "rin doctor",
    "rin --help",
    "rin update",
    "rin usage",
    "docs/user/getting-started.md",
    "docs/troubleshooting.md",
    "CHANGELOG.md",
    "docs/architecture.md",
    "docs/release-management.md",
  ];

  for (const readme of publicReadmes) {
    for (const snippet of requiredSnippets) {
      assert.match(
        readme.content,
        new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }

    for (const link of markdownLinks(readme.content)) {
      if (/^https?:\/\//.test(link) || link.startsWith("#")) continue;
      const resolved = path.resolve(path.dirname(readme.filePath), link);
      assert.equal(fs.existsSync(resolved), true, `${readme.name} -> ${link}`);
    }
  }
});

test("release docs and changelog stay aligned with the installed runtime contract", () => {
  const releaseDoc = fs.readFileSync(
    path.join(rootDir, "docs", "release-management.md"),
    "utf8",
  );
  const changelog = fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const gettingStarted = fs.readFileSync(
    path.join(rootDir, "docs", "user", "getting-started.md"),
    "utf8",
  );

  for (const snippet of [
    "`install.sh` bootstrap behavior",
    "`app/current`",
    "old release pruning",
    "`CHANGELOG.md`",
  ]) {
    assert.equal(releaseDoc.includes(snippet), true, snippet);
  }

  assert.match(gettingStarted, /prunes older runtime releases/);
  assert.match(
    gettingStarted,
    /prefer the stable `app\/current` path instead of a timestamped `app\/releases\/\.\.\.` path/,
  );
  assert.match(changelog, /install\.sh` bootstrap behavior/);
  assert.match(changelog, /app assembly entrypoints/);
  assert.match(changelog, /runtime release publishing/);
  assert.match(changelog, /sidecar lifecycle handling/);
});
