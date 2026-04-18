import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const renderUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "pi", "render-utils.js"),
  ).href,
);

test("render utils format shared truncation warnings and notices", () => {
  const lineTruncation = {
    truncated: true,
    truncatedBy: "lines",
    outputLines: 10,
    totalLines: 25,
    maxLines: 10,
  };
  const byteTruncation = {
    truncated: true,
    truncatedBy: "bytes",
    outputLines: 3,
    totalLines: 8,
    maxBytes: 1024,
  };
  const firstLineTruncation = {
    truncated: true,
    truncatedBy: "bytes",
    outputLines: 0,
    totalLines: 1,
    maxBytes: 2048,
    firstLineExceedsLimit: true,
  };

  assert.equal(
    renderUtils.formatTruncationWarningMessage(lineTruncation),
    "Truncated: showing 10 of 25 lines (10 line limit)",
  );
  assert.equal(
    renderUtils.formatTruncationWarningMessage(byteTruncation),
    "Truncated: 3 lines shown (1.0KB limit)",
  );
  assert.equal(
    renderUtils.formatTruncationWarningMessage(firstLineTruncation),
    "First line exceeds 2.0KB limit",
  );

  assert.equal(
    renderUtils.formatTruncationNotice(lineTruncation),
    "[Showing 10 of 25 lines.]",
  );
  assert.equal(
    renderUtils.formatTruncationNotice(byteTruncation),
    "[Showing 3 of 8 lines (1.0KB limit).]",
  );
  assert.equal(
    renderUtils.formatTruncationNotice(firstLineTruncation),
    "[First line exceeds 2.0KB limit.]",
  );
  assert.equal(
    renderUtils.appendTruncationNotice("hello", lineTruncation),
    "hello\n\n[Showing 10 of 25 lines.]",
  );
});

test("render utils format shared tool durations", () => {
  assert.equal(renderUtils.formatToolDuration(undefined, undefined), undefined);
  assert.equal(renderUtils.formatToolDuration(1000, 3500), "Took 2.5s");
});

test("render utils format shared hidden result notices", () => {
  assert.equal(renderUtils.formatHiddenResultsNotice(5, 2), "[Showing top 3 of 5 results.]");
  assert.equal(renderUtils.formatHiddenResultsNotice(5, 0), "");
});

test("render utils render shared text tool previews", () => {
  const theme = {
    fg: (kind, text) => `<${kind}>${text}</${kind}>`,
  };
  const truncation = {
    truncated: true,
    truncatedBy: "lines",
    outputLines: 2,
    totalLines: 4,
    maxLines: 2,
  };

  assert.equal(
    renderUtils.renderTextToolResult(
      {
        content: [{ type: "text", text: "alpha\nbeta" }],
        details: {
          emptyMessage: "Nothing here.",
        },
      },
      { expanded: false },
      theme,
      false,
      {
        extraMutedLines: [renderUtils.formatHiddenResultsNotice(5, 2)],
        truncation,
      },
    ),
    "\n<toolOutput>alpha</toolOutput>\n<toolOutput>beta</toolOutput>\n<muted>[Showing top 3 of 5 results.]</muted>\n<warning>[Truncated: showing 2 of 4 lines (2 line limit)]</warning>",
  );

  assert.equal(
    renderUtils.renderTextToolResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          emptyMessage: "Nothing here.",
        },
      },
      { expanded: false },
      theme,
      false,
    ),
    "\n<muted>Nothing here.</muted>",
  );

  assert.equal(
    renderUtils.renderTextToolResult(
      { content: [{ type: "text", text: "ignored" }] },
      { expanded: false, isPartial: true },
      theme,
      false,
      { partialText: "Fetching..." },
    ),
    "<warning>Fetching...</warning>",
  );
});
