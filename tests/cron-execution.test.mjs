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
    { agentDir: process.cwd() },
  );
  assert.ok(text.includes("Command: printf hello"));
  assert.ok(text.includes("stdout:"));
});

test("cron scheduler installs the built-in daily memory index repair task", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    const builtIn = scheduler
      .listTasks()
      .find((task) => task.id === "builtin_memory_index_repair_daily");
    assert.ok(builtIn);
    assert.equal(builtIn.builtIn, true);
    assert.equal(builtIn.trigger.kind, "cron");
    assert.equal(builtIn.trigger.expression, "17 4 * * *");
    assert.equal(builtIn.target.kind, "shell_command");
    assert.match(builtIn.target.command, /memory-index repair/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});


