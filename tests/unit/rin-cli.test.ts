import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href
);
const usage = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "usage.js")).href
);
const memoryIndex = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "memory-index.js"))
    .href
);
const main = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "main.js")).href
);

test("version subcommand prints package version without launching Rin", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
  );
  const output = execFileSync(
    process.execPath,
    [path.join(rootDir, "dist", "app", "rin", "main.js"), "version"],
    { cwd: rootDir, encoding: "utf8" },
  ).trim();

  assert.equal(output, packageJson.version);
  const parsed = shared.resolveParsedArgs("update", { version: "1.2.3" }, [
    "update",
    "--version",
    "1.2.3",
  ]);
  assert.equal(parsed.releaseVersion, "1.2.3");
});

test("usage and memory-index parsers ignore wrapper args around the subcommand", () => {
  assert.deepEqual(
    usage.parseUsageArgs([
      "-u",
      "rin",
      "usage",
      "--events",
      "--session",
      "rin-hidden",
      "--limit",
      "5",
    ]),
    {
      groupBy: [],
      filters: [],
      limit: 5,
      orderBy: "total_tokens",
      direction: "desc",
      events: true,
      includeZero: false,
      dimensions: false,
      help: false,
    },
  );

  assert.deepEqual(
    usage.parseUsageArgs([
      "--user=rin",
      "usage",
      "--events",
      "--session=rin-hidden",
      "--limit",
      "5",
    ]),
    {
      groupBy: [],
      filters: [],
      limit: 5,
      orderBy: "total_tokens",
      direction: "desc",
      events: true,
      includeZero: false,
      dimensions: false,
      help: false,
    },
  );

  assert.deepEqual(
    usage.parseUsageArgs([
      "usage",
      "--group-by",
      " provider_model , capability ,, ",
      "--filter",
      " source = extension ",
      "--direction",
      " ASC ",
    ]),
    {
      groupBy: ["provider_model", "capability"],
      filters: [{ key: "source", value: "extension" }],
      limit: 20,
      orderBy: "total_tokens",
      direction: "asc",
      events: false,
      includeZero: false,
      dimensions: false,
      help: false,
    },
  );

  assert.deepEqual(
    memoryIndex.parseMemoryIndexArgs([
      "memory-index",
      "repair",
      "--session",
      "rin-hidden",
      "-u",
      "rin",
      "--help",
    ]),
    {
      action: "repair",
      help: true,
    },
  );

  assert.deepEqual(
    memoryIndex.parseMemoryIndexArgs([
      "--user=rin",
      "memory-index",
      "repair",
      "--session=rin-hidden",
      "--help",
    ]),
    {
      action: "repair",
      help: true,
    },
  );
});

test("captureInternalRinCommand forwards only subcommand args", () => {
  const calls = [];
  const result = shared.captureInternalRinCommand(
    {
      repoRoot: "/repo",
      capture(argv) {
        calls.push(argv);
        return "forwarded";
      },
    },
    "__usage_internal",
    ["--user=rin", "usage", "--events", "--session=rin-hidden", "--limit", "5"],
    "usage",
  );

  assert.equal(result, "forwarded");
  assert.deepEqual(calls, [
    [
      process.execPath,
      path.join("/repo", "dist", "app", "rin", "main.js"),
      "__usage_internal",
      "--events",
      "--limit",
      "5",
    ],
  ]);
});

test("usage parser rejects invalid filter syntax after trimming", () => {
  assert.throws(
    () => usage.parseUsageArgs(["usage", "--filter", " source= "]),
    /invalid_filter:source=/,
  );
});

test("resolveInternalRinDispatch detects internal markers and wrapped subcommand help", () => {
  const usageHelp = main.resolveInternalRinDispatch([
    "-u",
    "rin",
    "usage",
    "--help",
  ]);
  assert.ok(usageHelp);
  assert.equal(usageHelp.run, usage.runUsageInternal);
  assert.deepEqual(usageHelp.args, ["--help"]);

  const memoryInternal = main.resolveInternalRinDispatch([
    "__memory_index_internal",
    "repair",
  ]);
  assert.ok(memoryInternal);
  assert.equal(memoryInternal.run, memoryIndex.runMemoryIndexInternal);
  assert.deepEqual(memoryInternal.args, ["repair"]);
});
