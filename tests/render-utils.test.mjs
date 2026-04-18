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
