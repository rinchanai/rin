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
const changelog = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "changelog.js"))
    .href,
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-changelog-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("changelog parser ignores intro text, skips empty sections, and normalizes CRLF", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "CHANGELOG.md");
    await fs.writeFile(
      filePath,
      [
        "# Changelog",
        "",
        "Intro text that should be ignored.",
        "",
        "## 1.2.0",
        "",
        "- Added feature A",
        "- Fixed bug B",
        "",
        "## 1.1.0",
        "",
        "## 1.0.0",
        "",
        "- Initial release",
        "",
      ].join("\r\n"),
      "utf8",
    );

    assert.deepEqual(changelog.parseChangelog(filePath), [
      {
        heading: "1.2.0",
        content: "## 1.2.0\n- Added feature A\n- Fixed bug B",
      },
      {
        heading: "1.0.0",
        content: "## 1.0.0\n- Initial release",
      },
    ]);
  });
});

test("changelog parser returns empty entries for missing files", () => {
  assert.deepEqual(changelog.parseChangelog("/tmp/rin-missing-changelog.md"), []);
});

test("changelog path prefers runtime agent docs when that file exists", async () => {
  await withTempDir(async (dir) => {
    const previousRinDir = process.env.RIN_DIR;
    try {
      process.env.RIN_DIR = dir;
      const expectedPath = path.join(dir, "docs", "pi", "CHANGELOG.md");
      await fs.mkdir(path.dirname(expectedPath), { recursive: true });
      await fs.writeFile(expectedPath, "## 1.0.0\n- Ready\n", "utf8");
      assert.equal(changelog.getChangelogPath(), expectedPath);
    } finally {
      if (previousRinDir === undefined) delete process.env.RIN_DIR;
      else process.env.RIN_DIR = previousRinDir;
    }
  });
});
