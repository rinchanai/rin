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

test("session ref helpers normalize aliases and resolve selectors consistently", () => {
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
