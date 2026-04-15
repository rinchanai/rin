import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const policy = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-bridge", "policy.js"))
    .href
);

test("chat policy allows trusted users to abort and start new chat sessions", () => {
  assert.equal(policy.canRunCommand("TRUSTED", "new"), true);
  assert.equal(policy.canRunCommand("TRUSTED", "abort"), true);
});

test("chat policy still blocks higher-impact chat commands for trusted users", () => {
  assert.equal(policy.canRunCommand("TRUSTED", "resume"), false);
  assert.equal(policy.canRunCommand("TRUSTED", "model"), false);
  assert.equal(policy.canRunCommand("TRUSTED", "reload"), false);
});

test("chat policy keeps non-help commands restricted while owners retain full command access", () => {
  assert.equal(policy.canRunCommand("OTHER", "help"), false);
  assert.equal(policy.canRunCommand("OTHER", "abort"), false);
  assert.equal(policy.canRunCommand("OWNER", "abort"), true);
  assert.equal(policy.canRunCommand("OWNER", "resume"), true);
});
