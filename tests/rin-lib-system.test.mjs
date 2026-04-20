import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const system = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "system.js"))
    .href,
);
const common = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "common.js"))
    .href,
);

test("rin system normalizes current-user shell launches", () => {
  const currentUser = os.userInfo().username;
  const launch = system.buildUserShell(` ${currentUser} `, ["node", "app.js"], {
    DEMO_FLAG: "1",
  });

  assert.equal(launch.command, "node");
  assert.deepEqual(launch.args, ["app.js"]);
  assert.equal(launch.env.DEMO_FLAG, "1");
});

test("rin system falls back safely for unknown user runtime paths", () => {
  const missingUser = "rin-missing-user-for-test";

  assert.equal(
    system.socketPathForUser(missingUser),
    common.defaultDaemonSocketPath(),
  );
  assert.deepEqual(system.targetUserRuntimeEnv(missingUser, { DEMO_FLAG: "1" }), {
    DEMO_FLAG: "1",
  });
  assert.throws(
    () => system.buildUserShell(missingUser, ["node", "app.js"]),
    /target_user_not_found:rin-missing-user-for-test/,
  );
});

test("rin system trims user lookup inputs consistently", () => {
  const currentUser = os.userInfo().username;
  const lookedUp = system.readPasswdUser(` ${currentUser} `);
  const expectedHomeRoot = process.platform === "darwin" ? "/Users" : "/home";

  assert.equal(lookedUp?.name, currentUser);
  assert.equal(
    system.homeForUser(" demo-user "),
    path.join(expectedHomeRoot, "demo-user"),
  );
});

test("shellQuote preserves embedded single quotes for sh -lc", () => {
  const script =
    "const value='node:net'; if (value !== 'node:net') process.exit(41);";
  const command = `${system.shellQuote(process.execPath)} -e ${system.shellQuote(script)}`;
  execFileSync("sh", ["-lc", command], { stdio: "inherit" });
});

test("shellQuote round-trips paths and event names used by daemon probes", () => {
  const script = [
    "const socketPath='/run/user/1001/rin-daemon/daemon.sock';",
    "const eventName='connect';",
    "if (socketPath !== '/run/user/1001/rin-daemon/daemon.sock') process.exit(42);",
    "if (eventName !== 'connect') process.exit(43);",
  ].join("");
  const command = `${system.shellQuote(process.execPath)} -e ${system.shellQuote(script)}`;
  execFileSync("sh", ["-lc", command], { stdio: "inherit" });
  assert.ok(command.includes(`'"'"'connect'"'"'`));
});
