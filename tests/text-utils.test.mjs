import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const textUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "text-utils.js")).href,
);

test("text utils normalize strings consistently", () => {
  assert.equal(textUtils.safeString(null), "");
  assert.equal(textUtils.safeString(42), "42");
  assert.equal(
    textUtils.trimText("  alpha\n beta\t gamma  ", 12),
    "alpha beta…",
  );
  assert.deepEqual(
    textUtils.uniqueStrings([" Alpha ", "alpha", "Beta", "beta ", ""]),
    ["Alpha", "Beta"],
  );
  assert.equal(
    textUtils.normalizeNeedle("  Hello\nWORLD  "),
    "hello world",
  );
  assert.deepEqual(
    textUtils.latinTokens("Demo/path demo_path B x yz HTTP/API"),
    ["demo/path", "demo_path", "http/api"],
  );
});
