import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href,
);
const usage = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "usage.js")).href,
);
const memoryIndex = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin", "memory-index.js"),
  ).href,
);
const main = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "main.js")).href,
);

test("usage and memory-index parsers ignore wrapper args around the subcommand", () => {
  assert.deepEqual(
    usage.parseUsageArgs([
      "-u",
      "rin",
      "usage",
      "--events",
      "--tmux",
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
    memoryIndex.parseMemoryIndexArgs([
      "memory-index",
      "repair",
      "--tmux",
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
    ["-u", "rin", "usage", "--events", "--limit", "5"],
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
