import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const textUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "fetch", "text-utils.js"))
    .href
);

test("fetch text utils decode named and numeric html entities", () => {
  assert.equal(
    textUtils.decodeHtmlEntities("A&amp;B &#169; &#x1f642; &unknown;"),
    "A&B © 🙂 &unknown;",
  );
});
