import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const launcher = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "launcher.js"))
    .href
);

test("tui launcher normalizes explicit mode inputs", () => {
  assert.equal(launcher.normalizeTuiMode(" std "), "std");
  assert.equal(launcher.normalizeTuiMode("RPC"), "rpc");
  assert.equal(launcher.normalizeTuiMode("invalid"), undefined);
  assert.equal(launcher.resolveTuiMode([]), "rpc");
  assert.equal(launcher.resolveTuiMode(["--std"]), "std");
  assert.equal(launcher.resolveTuiMode(["--rpc"]), "rpc");
  assert.equal(launcher.resolveTuiMode([], { RIN_TUI_MODE: " std " }), "std");
});

test("tui launcher rejects invalid or conflicting mode requests", () => {
  assert.throws(
    () => launcher.resolveTuiMode([], { RIN_TUI_MODE: "broken" }),
    /Invalid RIN_TUI_MODE: broken\. Allowed values: rpc, std\./,
  );
  assert.throws(
    () => launcher.resolveTuiMode(["--std", "--rpc"]),
    /Conflicting TUI mode flags: --std, --rpc\./,
  );
  assert.throws(
    () => launcher.resolveTuiMode(["--rpc"], { RIN_TUI_MODE: "std" }),
    /Conflicting TUI mode requests: RIN_TUI_MODE=std and --rpc\./,
  );
});

test("tui launcher startup spacer is limited to TTY output", () => {
  assert.equal(launcher.shouldPrintTuiStartupSpacer({ isTTY: true }), true);
  assert.equal(launcher.shouldPrintTuiStartupSpacer({ isTTY: false }), false);
  assert.equal(launcher.shouldPrintTuiStartupSpacer({}), false);
});

test("tui launcher formats daemon startup socket failures with doctor/std guidance", () => {
  const message = launcher.formatTuiStartupError(
    new Error("connect ECONNREFUSED /run/user/1001/rin-daemon/daemon.sock"),
  );
  assert.match(
    message,
    /RPC TUI could not connect to the daemon \(connect ECONNREFUSED \/run\/user\/1001\/rin-daemon\/daemon\.sock\)\./,
  );
  assert.match(message, /Try `rin doctor`/);
  assert.match(message, /`rin --std`/);
});

test("tui launcher leaves unrelated startup errors unchanged", () => {
  assert.equal(launcher.formatTuiStartupError(new Error("boom")), "boom");
});
