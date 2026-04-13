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
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "cron.js"))
    .href
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

test("cron execution clears stale errors after a successful shell run", async () => {
  const task = {
    id: "task-success",
    enabled: true,
    running: true,
    runCount: 1,
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    trigger: { kind: "once", runAt: "2026-04-12T00:00:00.000Z" },
    session: { mode: "current" },
    target: { kind: "shell_command", command: "printf hello" },
    lastError: "previous failure",
  };

  await execMod.executeCronTask(task, { agentDir: "/tmp/rin-agent" });

  assert.match(task.lastResultText || "", /Command: printf hello/);
  assert.equal(task.lastError, undefined);
  assert.equal(task.running, false);
  assert.ok(task.lastFinishedAt);
  assert.ok(task.updatedAt);
});

test("cron execution clears stale results after a failed shell run", async () => {
  const task = {
    id: "task-failure",
    enabled: true,
    running: true,
    runCount: 1,
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    trigger: { kind: "once", runAt: "2026-04-12T00:00:00.000Z" },
    session: { mode: "current" },
    target: { kind: "shell_command", command: "printf boom >&2; exit 7" },
    lastResultText: "previous success",
  };

  await execMod.executeCronTask(task, { agentDir: "/tmp/rin-agent" });

  assert.equal(task.lastResultText, undefined);
  assert.match(task.lastError || "", /Exit: 7/);
  assert.match(task.lastError || "", /stderr:/);
  assert.equal(task.running, false);
  assert.ok(task.lastFinishedAt);
  assert.ok(task.updatedAt);
});

test("cron agent execution keeps dedicated session files from rpc results", async () => {
  const task = {
    id: "task-agent-session",
    session: { mode: "dedicated" },
    dedicatedSessionFile: "/tmp/old-session.jsonl",
    target: { kind: "agent_prompt", prompt: "hello" },
  };

  const result = await execMod.executeCronAgentTask(task, {
    agentDir: "/tmp/rin-agent",
    requestKoishiRpc: async () => ({
      finalText: "final response",
      sessionId: "session-42",
      sessionFile: "/tmp/new-session.jsonl",
    }),
  });

  assert.equal(result.text, "final response");
  assert.equal(result.sessionId, "session-42");
  assert.equal(result.sessionFile, "/tmp/new-session.jsonl");
  assert.equal(task.dedicatedSessionFile, "/tmp/new-session.jsonl");
});

test("cron agent execution does not fail when a turn completes without visible final text", async () => {
  const deliveries = [];
  const task = {
    id: "task-agent-empty",
    enabled: true,
    running: true,
    runCount: 1,
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    trigger: { kind: "once", runAt: "2026-04-12T00:00:00.000Z" },
    session: { mode: "current", sessionFile: "/tmp/current-session.jsonl" },
    target: { kind: "agent_prompt", prompt: "hello" },
    chatKey: "onebot/123:456",
    lastResultText: "previous visible result",
    lastError: "previous failure",
  };

  await execMod.executeCronTask(task, {
    agentDir: "/tmp/rin-agent",
    requestKoishiRpc: async () => ({
      finalText: "   ",
      sessionId: "session-empty",
      sessionFile: "/tmp/current-session.jsonl",
    }),
    sendKoishiText: async (_agentDir, payload) => {
      deliveries.push(payload);
    },
  });

  assert.equal(task.lastResultText, undefined);
  assert.equal(task.lastError, undefined);
  assert.equal(task.running, false);
  assert.ok(task.lastFinishedAt);
  assert.ok(task.updatedAt);
  assert.deepEqual(deliveries, []);
});

test("cron agent execution delivers visible final text to bound chats", async () => {
  const deliveries = [];
  const task = {
    id: "task-agent-visible",
    enabled: true,
    running: true,
    runCount: 1,
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    trigger: { kind: "once", runAt: "2026-04-12T00:00:00.000Z" },
    session: { mode: "current", sessionFile: "/tmp/current-session.jsonl" },
    target: { kind: "agent_prompt", prompt: "hello" },
    chatKey: "onebot/123:456",
  };

  await execMod.executeCronTask(task, {
    agentDir: "/tmp/rin-agent",
    requestKoishiRpc: async () => ({
      finalText: "visible final text",
      sessionId: "session-visible",
      sessionFile: "/tmp/current-session.jsonl",
    }),
    sendKoishiText: async (_agentDir, payload) => {
      deliveries.push(payload);
    },
  });

  assert.equal(task.lastResultText, "visible final text");
  assert.equal(task.lastError, undefined);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].chatKey, "onebot/123:456");
  assert.equal(deliveries[0].taskId, "task-agent-visible");
  assert.equal(deliveries[0].text, "visible final text");
});
