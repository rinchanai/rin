import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const sessionRef = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "ref.js"))
    .href,
);

test("session ref helpers normalize shared command/state shapes and resolve consistently", () => {
  assert.deepEqual(
    sessionRef.normalizeSessionRef({
      sessionPath: " /tmp/demo.jsonl ",
      sessionId: " demo-session ",
    }),
    {
      sessionFile: "/tmp/demo.jsonl",
      sessionId: "demo-session",
    },
  );

  assert.deepEqual(
    sessionRef.normalizeSessionRef({
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
    sessionRef.normalizeSessionRef({
      sessionFile: " /tmp/state.jsonl ",
      sessionId: " state-session ",
    }),
    {
      sessionFile: "/tmp/state.jsonl",
      sessionId: "state-session",
    },
  );

  assert.equal(
    sessionRef.hasSessionRef({ sessionId: undefined, sessionFile: undefined }),
    false,
  );
  assert.equal(
    sessionRef.hasSessionRef({ sessionId: "demo-session" }),
    true,
  );

  assert.deepEqual(
    sessionRef.resolveSessionRef(
      {},
      { sessionFile: "/tmp/fallback.jsonl", sessionId: "fallback" },
    ),
    { sessionFile: "/tmp/fallback.jsonl", sessionId: "fallback" },
  );

  assert.equal(
    sessionRef.sessionRefMatches(
      { sessionFile: "/tmp/demo.jsonl", sessionId: "demo-session" },
      { sessionFile: "/tmp/demo.jsonl" },
    ),
    true,
  );
  assert.equal(
    sessionRef.sessionRefMatches(
      { sessionFile: "/tmp/demo.jsonl", sessionId: "demo-session" },
      { sessionId: "other-session" },
    ),
    false,
  );
});
