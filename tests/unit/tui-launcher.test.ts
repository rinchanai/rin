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

test("tui launcher uses only the maintenance-mode environment switch", () => {
  assert.equal(launcher.shouldStartMaintenanceMode({}), false);
  assert.equal(
    launcher.shouldStartMaintenanceMode({ RIN_TUI_MAINTENANCE_MODE: "1" }),
    true,
  );
  assert.equal(
    launcher.shouldStartMaintenanceMode({ RIN_TUI_MAINTENANCE_MODE: "true" }),
    true,
  );
  assert.equal(
    launcher.shouldStartMaintenanceMode({ RIN_TUI_MAINTENANCE_MODE: "no" }),
    false,
  );
});

test("tui launcher resolves interactive startup options", () => {
  assert.deepEqual(launcher.resolveTuiInteractiveOptions([]), {
    initialMessage: undefined,
    initialMessages: undefined,
    verbose: undefined,
  });
  assert.deepEqual(launcher.resolveTuiInteractiveOptions(["--verbose"]), {
    initialMessage: undefined,
    initialMessages: undefined,
    verbose: true,
  });
  assert.deepEqual(launcher.resolveTuiInteractiveOptions(["/init", "next"]), {
    initialMessage: "/init",
    initialMessages: ["next"],
    verbose: undefined,
  });
  assert.deepEqual(
    launcher.resolveTuiInteractiveOptions(["--unknown", "--", "--literal"]),
    {
      initialMessage: "--literal",
      initialMessages: undefined,
      verbose: undefined,
    },
  );
});

test("tui launcher prints its startup separator independently of startup verbosity", () => {
  const quietSession = {
    settingsManager: {
      getQuietStartup: () => true,
    },
  };

  assert.equal(launcher.shouldPrintStartupSeparator(quietSession), true);
  assert.equal(
    launcher.shouldPrintStartupSeparator(undefined, { verbose: false }),
    true,
  );
});

test("tui launcher formats daemon startup socket failures with doctor/reopen guidance", () => {
  const message = launcher.formatTuiStartupError(
    new Error("connect ECONNREFUSED /run/user/1001/rin-daemon/daemon.sock"),
  );
  assert.match(
    message,
    /RPC TUI could not connect to the daemon \(connect ECONNREFUSED \/run\/user\/1001\/rin-daemon\/daemon\.sock\)\./,
  );
  assert.match(message, /Try `rin doctor`/);
  assert.match(message, /temporary maintenance mode/);
});

test("tui launcher leaves unrelated startup errors unchanged", () => {
  assert.equal(launcher.formatTuiStartupError(new Error("boom")), "boom");
});
