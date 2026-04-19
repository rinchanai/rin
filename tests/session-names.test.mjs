import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const names = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "names.js"))
    .href,
);
const listing = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "listing.js"))
    .href,
);

test("readSessionDisplayNameParts combines latest rename with first user message", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-session-names-"));
  const sessionFile = path.join(sessionDir, "demo.jsonl");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session_info", name: "Initial title" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "  First   question  " },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Answer" },
      }),
      JSON.stringify({ type: "session_info", name: "Renamed title" }),
      "{not valid json}",
      "",
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(names.readSessionDisplayNameParts(sessionFile), {
    currentName: "Renamed title",
    firstUserMessage: "First question",
  });

  await fs.rm(sessionDir, { recursive: true, force: true });
});

test("session display helpers keep name fallback rules consistent", () => {
  assert.equal(
    listing.getBoundSessionDisplayTitle({
      name: " Renamed title ",
      firstMessage: " First question ",
      path: "/tmp/demo.jsonl",
      modified: new Date("2026-04-19T00:00:00.000Z"),
    }),
    "Renamed title",
  );
  assert.equal(
    listing.getBoundSessionDisplayTitle({
      firstMessage: " First question ",
      path: "/tmp/demo.jsonl",
      modified: new Date("2026-04-19T00:00:00.000Z"),
    }),
    "First question",
  );
  assert.equal(
    listing.getBoundSessionDisplayTitle({
      path: "/tmp/demo.jsonl",
      modified: new Date("2026-04-19T00:00:00.000Z"),
    }),
    "/tmp/demo.jsonl",
  );
  assert.equal(listing.getBoundSessionDisplayTitle({}), "Untitled session");
});
