import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const execMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "cron-execution.js"),
  ).href
);
const cronMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "cron.js"),
  ).href
);

test("cron execution resolves session file preference", async () => {
  assert.equal(
    await execMod.resolveCronSessionFile({
      session: { mode: "current", sessionFile: "/tmp/a" },
    }),
    "/tmp/a",
  );
  assert.equal(
    await execMod.resolveCronSessionFile({
      session: { mode: "dedicated" },
      dedicatedSessionFile: "/tmp/b",
    }),
    "/tmp/b",
  );
});

test("cron scheduler rejects removed specific session mode", () => {
  const scheduler = new cronMod.CronScheduler({
    agentDir: "/tmp/rin-agent",
    cwd: process.cwd(),
  });
  assert.throws(
    () =>
      scheduler.upsertTask({
        trigger: { kind: "once", runAt: "2026-04-10T00:00:00.000Z" },
        session: { mode: "specific", sessionFile: "/tmp/a" },
        target: { kind: "agent_prompt", prompt: "hello" },
      }),
    /cron_invalid_session_mode:specific/,
  );
});

test("cron execution shell task returns summarized success body", async () => {
  const text = await execMod.executeCronShellTask(
    {
      target: { kind: "shell_command", command: "printf hello" },
      cwd: process.cwd(),
    },
    process.cwd(),
  );
  assert.ok(text.includes("Command: printf hello"));
  assert.ok(text.includes("stdout:"));
});
