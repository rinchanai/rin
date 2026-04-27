import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const applyPlan = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "apply-plan.js"),
  ).href
);

test("runFinalizeInstallPlanInChild inherits stdio so sudo prompts stay interactive", async () => {
  const statuses = [];
  const spawnCalls = [];

  const result = await applyPlan.runFinalizeInstallPlanInChild(
    {
      currentUser: "alice",
      targetUser: "bob",
      installDir: "/srv/rin",
    },
    "Publishing runtime and writing configuration with elevated permissions...",
    {
      writeStatus(message) {
        statuses.push(message);
      },
      spawnImpl(command, args, options) {
        spawnCalls.push({ command, args, options });
        const child = new EventEmitter();
        setImmediate(() => {
          fs.writeFileSync(
            options.env.RIN_INSTALL_APPLY_RESULT,
            JSON.stringify({ ok: true }),
            "utf8",
          );
          child.emit("exit", 0, null);
        });
        return child;
      },
    },
  );

  assert.deepEqual(statuses, [
    "Publishing runtime and writing configuration with elevated permissions...",
  ]);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].options.stdio, [
    "inherit",
    "inherit",
    "inherit",
  ]);
  assert.equal(
    typeof spawnCalls[0].options.env.RIN_INSTALL_APPLY_PLAN,
    "string",
  );
  assert.deepEqual(result, { ok: true });
});

test("runFinalizeInstallPlanInChild surfaces child error output on failure", async () => {
  await assert.rejects(
    applyPlan.runFinalizeInstallPlanInChild(
      {
        currentUser: "alice",
        targetUser: "bob",
        installDir: "/srv/rin",
      },
      "Publishing runtime...",
      {
        writeStatus() {},
        spawnImpl(_command, _args, options) {
          const child = new EventEmitter();
          setImmediate(() => {
            fs.writeFileSync(
              options.env.RIN_INSTALL_APPLY_ERROR,
              "sudo interaction failed",
              "utf8",
            );
            child.emit("exit", 1, null);
          });
          return child;
        },
      },
    ),
    /sudo interaction failed/,
  );
});
