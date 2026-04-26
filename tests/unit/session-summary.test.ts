import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const sessionSummary = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "summary.js"))
    .href
);

test("session summary prompt keeps file path as instruction-only context", () => {
  const prompt = sessionSummary.buildSessionRecallSummaryPrompt(
    "/tmp/demo-session.jsonl",
  );

  assert.match(prompt, /no more than three short sentences/);
  assert.match(prompt, /The session file path is: \/tmp\/demo-session\.jsonl/);
  assert.match(prompt, /Do not include the path in the final answer\./);
  assert.match(prompt, /Do not output anything other than that summary\./);
  assert.match(
    sessionSummary.buildSessionRecallSummaryPrompt("   "),
    /The session file path is: \(unknown\)/,
  );
});

test("session summary text normalizes whitespace and truncates consistently", () => {
  assert.equal(
    sessionSummary.normalizeSessionSummaryText("  first\n\nsecond\tthird  "),
    "first second third",
  );
  assert.equal(sessionSummary.normalizeSessionSummaryText("   \n\t "), "");
  assert.equal(sessionSummary.normalizeSessionSummaryText("short", 5), "short");
  assert.equal(
    sessionSummary.normalizeSessionSummaryText("abcdef", 5),
    "abcd…",
  );
  assert.equal(sessionSummary.normalizeSessionSummaryText("abcdef", 1), "…");
  assert.equal(
    sessionSummary.normalizeSessionSummaryText("abcdef", 4.9),
    "abc…",
  );
});

test("session summary text falls back to the default limit for invalid max values", () => {
  const longText = `${"a".repeat(200)} tail`;
  const expectedDefault = `${"a".repeat(179)}…`;

  assert.equal(
    sessionSummary.normalizeSessionSummaryText(longText, 0),
    expectedDefault,
  );
  assert.equal(
    sessionSummary.normalizeSessionSummaryText(longText, -1),
    expectedDefault,
  );
  assert.equal(
    sessionSummary.normalizeSessionSummaryText(longText, Number.NaN),
    expectedDefault,
  );
});
