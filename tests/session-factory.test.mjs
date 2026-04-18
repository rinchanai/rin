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
const factory = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "factory.js"))
    .href,
);

test("listBoundSessions reads only canonical root sessions", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-sessions-"));
  await fs.mkdir(path.join(sessionDir, "legacy"));
  const listed = [];
  const sessions = await factory.listBoundSessions({
    cwd: "/tmp/project",
    sessionDir,
    SessionManager: {
      async list(_cwd, dir) {
        listed.push(dir);
        if (dir !== sessionDir) return [];
        return [
          {
            id: "older",
            path: path.join(dir, "older.jsonl"),
            modified: new Date("2026-04-16T00:00:00.000Z"),
          },
          {
            id: "newer",
            path: path.join(dir, "newer.jsonl"),
            modified: new Date("2026-04-17T00:00:00.000Z"),
          },
          {
            id: "duplicate-newer",
            path: path.join(dir, "newer.jsonl"),
            modified: new Date("2026-04-18T00:00:00.000Z"),
          },
        ];
      },
    },
  });

  assert.deepEqual(sessions.map((item) => item.id), ["newer", "older"]);
  assert.deepEqual(listed, [sessionDir]);
  await fs.rm(sessionDir, { recursive: true, force: true });
});
