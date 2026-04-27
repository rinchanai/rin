import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const regexUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "fetch", "regex-utils.js"))
    .href
);
const textUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "fetch", "text-utils.js"))
    .href
);
const htmlUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "fetch", "html-utils.js"))
    .href
);

test("fetch regex utils apply replacements in sequence over normalized text input", () => {
  assert.equal(
    regexUtils.applyRegexReplacements("a &amp; b", [
      [/&amp;/g, "&"],
      [/a & b/g, "done"],
    ]),
    "done",
  );
  assert.equal(regexUtils.applyRegexReplacements(null, []), "");
});

test("fetch text utils decode named, decimal, and hex html entities", () => {
  assert.equal(
    textUtils.decodeHtmlEntities("Tom&nbsp;&amp;&nbsp;Jerry &#169; &#x1f63a;"),
    "Tom & Jerry © 😺",
  );
});

test("fetch html utils strip hidden blocks while preserving visible structure", () => {
  assert.equal(
    htmlUtils.htmlToText(`<!doctype html>
<html>
  <head>
    <title>Ignored in body projection</title>
  </head>
  <body>
    <div hidden><p>secret</p></div>
    <section>
      <h1>Hello</h1>
      <ul><li>One</li><li>Two</li></ul>
    </section>
    <div aria-hidden="true"><p>also hidden</p></div>
  </body>
</html>`),
    "Hello\n\n- One\n\n- Two",
  );
});
