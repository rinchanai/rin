import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
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
const launch = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "launch.js")).href
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

test("tmux socket args target the caller-owned hidden socket", () => {
  assert.deepEqual(launch.buildTmuxSocketArgs("demo"), ["-L", "rin-demo"]);
});

test("tui runtime env targets the target user's direct daemon socket", () => {
  const currentUser = os.userInfo().username;
  const env = launch.buildTuiRuntimeEnv(
    currentUser,
    "THE_cattail",
    `/home/${currentUser}/.rin`,
  );
  assert.equal(env.RIN_DIR, `/home/${currentUser}/.rin`);
  assert.equal(env.PI_CODING_AGENT_DIR, `/home/${currentUser}/.rin`);
  assert.equal(env.RIN_INVOKING_SYSTEM_USER, "THE_cattail");
  assert.ok(String(env.RIN_DAEMON_SOCKET_PATH || "").includes("rin-daemon"));
  assert.ok(!String(env.RIN_DAEMON_SOCKET_PATH || "").includes("bridge.sock"));
});

test("tmux list targets hidden Rin sessions", () => {
  assert.deepEqual(launch.buildTmuxListArgs(["-L", "rin-demo"]), [
    "tmux",
    "-L",
    "rin-demo",
    "list-sessions",
    "-F",
    "#S",
  ]);
});
