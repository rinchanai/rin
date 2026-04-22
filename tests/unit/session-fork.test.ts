import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const sessionFork = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "fork.js")).href,
);

test("session fork compat uses legacy persisted fork when option-aware native fork is unavailable", () => {
  const calls = [];
  class LegacySessionManager {}
  LegacySessionManager.forkFrom = function (sourcePath, targetCwd, sessionDir) {
    calls.push([sourcePath, targetCwd, sessionDir]);
    return { mode: "legacy" };
  };

  const result = sessionFork.forkSessionManagerCompat(
    LegacySessionManager,
    "/tmp/source.jsonl",
    "/tmp/cwd",
    "/tmp/sessions",
    { persist: true, leafId: " leaf-1 " },
  );

  assert.deepEqual(calls, [["/tmp/source.jsonl", "/tmp/cwd", "/tmp/sessions"]]);
  assert.deepEqual(result, { mode: "legacy" });
});

test("session fork compat rebuilds ephemeral forks from the selected branch", () => {
  const branchCalls = [];
  class FallbackSessionManager {
    constructor(cwd, sessionDir, _unused, persisted) {
      this.cwd = cwd;
      this.sessionDir = sessionDir;
      this.persisted = persisted;
      this.fileEntries = [];
      this.sessionId = "";
      this.sessionFile = "/tmp/should-clear.jsonl";
      this.flushed = true;
    }

    static open(sourcePath, sessionDir) {
      assert.equal(sourcePath, "/tmp/source.jsonl");
      assert.equal(sessionDir, "/tmp/sessions");
      return {
        getHeader() {
          return { version: "5", title: "source" };
        },
        getBranch(leafId) {
          branchCalls.push(leafId);
          return [{ id: "u1" }, { id: "a1" }];
        },
        getEntries() {
          throw new Error("should_not_read_full_entries");
        },
      };
    }

    _buildIndex() {
      this.indexBuilt = true;
    }

    isPersisted() {
      return this.persisted;
    }

    getSessionFile() {
      return this.sessionFile;
    }

    getEntries() {
      return this.fileEntries;
    }
  }

  const fork = sessionFork.forkSessionManagerCompat(
    FallbackSessionManager,
    "/tmp/source.jsonl",
    "/tmp/cwd",
    "/tmp/sessions",
    { persist: false, leafId: " leaf-1 " },
  );

  assert.deepEqual(branchCalls, ["leaf-1"]);
  assert.equal(fork.isPersisted(), false);
  assert.equal(fork.getSessionFile(), undefined);
  assert.equal(fork.flushed, false);
  assert.equal(fork.indexBuilt, true);
  assert.equal(fork.getEntries()[0].type, "session");
  assert.equal(fork.getEntries()[0].version, 5);
  assert.equal(fork.getEntries()[0].cwd, "/tmp/cwd");
  assert.equal(fork.getEntries()[0].parentSession, "/tmp/source.jsonl");
  assert.deepEqual(fork.getEntries().slice(1), [{ id: "u1" }, { id: "a1" }]);
});

test("session fork compat falls back to full entries when the requested branch is unavailable", () => {
  class FallbackSessionManager {
    constructor(cwd, sessionDir, _unused, persisted) {
      this.cwd = cwd;
      this.sessionDir = sessionDir;
      this.persisted = persisted;
      this.fileEntries = [];
      this.sessionId = "";
    }

    static open() {
      return {
        getHeader() {
          return {};
        },
        getBranch() {
          return [];
        },
        getEntries() {
          return [{ id: "full-u1" }, { id: "full-a1" }];
        },
      };
    }

    _buildIndex() {}

    getEntries() {
      return this.fileEntries;
    }
  }

  const fork = sessionFork.forkSessionManagerCompat(
    FallbackSessionManager,
    "/tmp/source.jsonl",
    "/tmp/cwd",
    "/tmp/sessions",
    { persist: false, leafId: "missing-leaf" },
  );

  assert.deepEqual(fork.getEntries().slice(1), [{ id: "full-u1" }, { id: "full-a1" }]);
});

test("session fork compat reports unsupported persisted and ephemeral capabilities clearly", () => {
  assert.throws(
    () =>
      sessionFork.forkSessionManagerCompat(
        {},
        "/tmp/source.jsonl",
        "/tmp/cwd",
        "/tmp/sessions",
        { persist: true },
      ),
    /session_fork_unsupported:persisted/,
  );
  assert.throws(
    () =>
      sessionFork.forkSessionManagerCompat(
        { open() {} },
        "/tmp/source.jsonl",
        "/tmp/cwd",
        "/tmp/sessions",
        { persist: false },
      ),
    /session_fork_unsupported:ephemeral/,
  );
});
