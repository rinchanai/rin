import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const rulesModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rules", "index.js")).href,
);

function getRulesTool() {
  const tools = [];
  rulesModule.default({
    registerTool(tool) {
      tools.push(tool);
    },
  });
  const tool = tools.find((entry) => entry.name === "rules");
  assert.ok(tool);
  return tool;
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-rules-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("rules helpers collect ancestor files with stable ordering and dedupe", () => {
  const targetDir = "/tmp/project/app/src";
  const ancestorDirs = rulesModule.collectRuleAncestorDirs(targetDir);
  assert.deepEqual(ancestorDirs.slice(0, 4), [
    "/tmp/project/app/src",
    "/tmp/project/app",
    "/tmp/project",
    "/tmp",
  ]);

  const files = rulesModule.collectRelevantRulesFiles(targetDir, [
    { path: "/tmp/project/app/AGENTS.md", content: "child" },
    { path: "/tmp/project/AGENTS.md", content: "root older" },
    { path: "/tmp/project/AGENTS.md", content: "root newer" },
    { path: "/tmp/other/AGENTS.md", content: "ignored" },
  ]);

  assert.deepEqual(files, [
    { path: "/tmp/project/AGENTS.md", content: "root newer" },
    { path: "/tmp/project/app/AGENTS.md", content: "child" },
  ]);
  assert.equal(
    rulesModule.formatRulesPrompt(files),
    [
      "# Project Context",
      "",
      "Project-specific instructions and guidelines:",
      "",
      "## /tmp/project/AGENTS.md",
      "",
      "root newer",
      "",
      "## /tmp/project/app/AGENTS.md",
      "",
      "child",
    ].join("\n"),
  );
});

test("rules tool returns empty text when no ancestor rules files exist", async () => {
  await withTempDir(async (dir) => {
    const targetDir = path.join(dir, "project", "src");
    await fs.mkdir(targetDir, { recursive: true });

    const result = await getRulesTool().execute(
      "tool-rules-empty",
      { path: targetDir },
      undefined,
      undefined,
    );

    assert.equal(result.content?.[0]?.text, "");
    assert.deepEqual(result.details, {});
  });
});

test("rules tool reports invalid, missing, and non-directory paths accurately", async () => {
  await withTempDir(async (dir) => {
    const missingPath = path.join(dir, "missing");
    const filePath = path.join(dir, "file.txt");
    await fs.writeFile(filePath, "demo", "utf8");

    await assert.rejects(
      () =>
        getRulesTool().execute(
          "tool-rules-relative",
          { path: " relative/path " },
          undefined,
          undefined,
        ),
      /Path must be absolute/,
    );
    await assert.rejects(
      () =>
        getRulesTool().execute(
          "tool-rules-missing",
          { path: missingPath },
          undefined,
          undefined,
        ),
      /Path not found/,
    );
    await assert.rejects(
      () =>
        getRulesTool().execute(
          "tool-rules-file",
          { path: filePath },
          undefined,
          undefined,
        ),
      /Not a directory/,
    );
  });
});

test("rules tool loads ancestor AGENTS and CLAUDE files in stable order", async () => {
  await withTempDir(async (dir) => {
    const projectDir = path.join(dir, "project");
    const packageDir = path.join(projectDir, "pkg");
    const targetDir = path.join(packageDir, "src");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "AGENTS.md"), "root rules\n", "utf8");
    await fs.writeFile(path.join(packageDir, "CLAUDE.md"), "package rules\n", "utf8");

    const result = await getRulesTool().execute(
      "tool-rules-found",
      { path: targetDir },
      undefined,
      undefined,
    );
    const text = String(result.content?.[0]?.text || "");

    assert.match(text, /# Project Context/);
    assert.match(text, /## .*project\/AGENTS\.md/);
    assert.match(text, /## .*project\/pkg\/CLAUDE\.md/);
    assert.match(text, /root rules/);
    assert.match(text, /package rules/);
    assert.ok(
      text.indexOf(path.join(projectDir, "AGENTS.md")) <
        text.indexOf(path.join(packageDir, "CLAUDE.md")),
    );
  });
});
