import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const schema = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "memory", "core", "schema.js"),
  ).href
);

test("memory schema parses and renders markdown docs consistently", () => {
  const doc = schema.parseMarkdownDoc(
    "/tmp/demo.md",
    `---\ntitle: Demo\nexposure: recall\ntags:\n  - one\n  - two\n---\nhello world\n`,
  );
  assert.equal(doc.title, "Demo");
  assert.deepEqual(doc.tags, ["one", "two"]);
  const rendered = schema.renderMarkdownDoc(doc);
  assert.ok(rendered.includes("title: Demo"));
  assert.ok(rendered.includes("hello world"));
});

test("memory schema normalizes defaults for resident docs", () => {
  const doc = schema.normalizeFrontmatter(
    { exposure: "resident", resident_slot: "owner_identity", content: "" },
    "/tmp/x.md",
    "hello",
  );
  assert.equal(doc.scope, "global");
  assert.equal(doc.kind, "preference");
  assert.equal(doc.resident_slot, "owner_identity");
});
