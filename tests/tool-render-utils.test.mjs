import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const renderUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "pi", "render-utils.js")).href
);

const theme = {
  fg(name, text) {
    return `<${name}>${text}</${name}>`;
  },
  bold(text) {
    return `**${text}**`;
  },
};

test("styleToolOutputLine highlights structured tool output", () => {
  assert.equal(
    renderUtils.styleToolOutputLine("path=/tmp/demo.txt", theme),
    "<muted>path</muted><dim>=</dim><accent>/tmp/demo.txt</accent>",
  );
  assert.equal(
    renderUtils.styleToolOutputLine("1. Example Result | 2026-04-17", theme),
    "<toolTitle>1. </toolTitle><toolOutput>**Example Result**</toolOutput><muted> | 2026-04-17</muted>",
  );
  assert.equal(
    renderUtils.styleToolOutputLine("Saved task: nightly cleanup", theme),
    "<toolTitle>**Saved task:**</toolTitle> <toolOutput>nightly cleanup</toolOutput>",
  );
});

test("renderTextToolResult renders warnings and empty states consistently", () => {
  const truncated = renderUtils.renderTextToolResult(
    {
      content: [{ type: "text", text: "web_search 2\npath=/tmp/demo.txt" }],
      details: {
        truncation: {
          truncated: true,
          truncatedBy: "lines",
          outputLines: 2,
          totalLines: 8,
          maxLines: 2,
        },
      },
    },
    { expanded: true },
    theme,
    false,
  );
  assert.match(truncated, /<toolTitle>\*\*web_search\*\*<\/toolTitle> <success>2<\/success>/);
  assert.match(truncated, /<warning>\[Truncated: showing 2 of 8 lines \(2 line limit\)\]<\/warning>/);

  const empty = renderUtils.renderTextToolResult(
    {
      content: [{ type: "text", text: "" }],
    },
    { expanded: true },
    theme,
    false,
    { emptyMessage: "No results." },
  );
  assert.equal(empty, "\n<muted>No results.</muted>");
});
