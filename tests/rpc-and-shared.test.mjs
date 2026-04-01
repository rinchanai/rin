import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const rpc = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "rpc.js")).href
);
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href
);

test("rpc helpers build success and failure envelopes", () => {
  assert.deepEqual(rpc.ok("1", "get_state", { ok: true }), {
    id: "1",
    type: "response",
    command: "get_state",
    success: true,
    data: { ok: true },
  });
  assert.deepEqual(rpc.fail("2", "prompt", new Error("boom")), {
    id: "2",
    type: "response",
    command: "prompt",
    success: false,
    error: "boom",
  });
});

test("shared resolveParsedArgs keeps passthrough and install defaults coherent", () => {
  const parsed = shared.resolveParsedArgs(
    "",
    { std: true, tmux: "", tmuxList: false, user: "demo" },
    ["--std", "--foo", "bar"],
  );
  assert.equal(parsed.targetUser, "demo");
  assert.equal(parsed.std, true);
  assert.deepEqual(parsed.passthrough, ["--foo", "bar"]);
});
