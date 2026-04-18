import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const selector = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "session-selector.js"),
  ).href,
);

test("session selector normalization trims values and accepts sessionPath alias", () => {
  assert.deepEqual(
    selector.normalizeSessionSelector({
      sessionPath: " /tmp/demo.jsonl ",
      sessionId: " demo-session ",
    }),
    {
      sessionFile: "/tmp/demo.jsonl",
      sessionId: "demo-session",
    },
  );

  assert.deepEqual(
    selector.sessionSelectorFromCommand({
      sessionFile: " /tmp/command.jsonl ",
      sessionPath: " /tmp/ignored.jsonl ",
      sessionId: " command-session ",
    }),
    {
      sessionFile: "/tmp/command.jsonl",
      sessionId: "command-session",
    },
  );

  assert.deepEqual(
    selector.sessionSelectorFromState({
      sessionFile: " /tmp/state.jsonl ",
      sessionId: " state-session ",
    }),
    {
      sessionFile: "/tmp/state.jsonl",
      sessionId: "state-session",
    },
  );
});
