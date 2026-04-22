import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const doctor = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "doctor.js")).href,
);

test("renderDoctorDaemonStatusLines includes worker and cron task details", () => {
  const lines = doctor.renderDoctorDaemonStatusLines({
    workerCount: 1,
    workers: [
      {
        id: "worker_1",
        pid: 321,
        role: "session",
        attachedConnections: 1,
        pendingResponses: 0,
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/session.json",
      },
    ],
    taskCount: 2,
    tasks: [
      {
        id: "cron_1",
        name: "Daily summary",
        enabled: true,
        runCount: 3,
        running: false,
        nextRunAt: "2026-04-22T13:00:00.000Z",
        session: { mode: "dedicated", sessionFile: "/tmp/cron-session.json" },
        trigger: { kind: "cron", expression: "0 21 * * *" },
        target: { kind: "agent_prompt", prompt: "Summarize the last day." },
      },
      {
        id: "cron_2",
        enabled: true,
        runCount: 1,
        running: true,
        session: { mode: "current" },
        trigger: { kind: "once", runAt: "2026-04-22T12:45:00.000Z" },
        target: { kind: "shell_command", command: "echo hello" },
      },
    ],
  });

  assert.ok(lines.includes("daemonWorkerCount=1"));
  assert.ok(
    lines.some(
      (line) =>
        line ===
        "daemonWorker=worker_1 pid=321 role=session attached=1 pending=0 streaming=false compacting=false session=/tmp/session.json",
    ),
  );
  assert.ok(lines.includes("daemonCronTaskCount=2"));
  assert.ok(lines.includes("daemonCronRunningCount=1"));
  assert.ok(
    lines.some(
      (line) =>
        line.includes("daemonCron=cron_1") &&
        line.includes('name="Daily summary"') &&
        line.includes('trigger="cron 0 21 * * *"') &&
        line.includes('target="agent_prompt:Summarize the last day."') &&
        line.includes('state="next:2026-04-22T13:00:00.000Z"'),
    ),
  );
  assert.ok(
    lines.some(
      (line) =>
        line.includes("daemonCron=cron_2") &&
        line.includes('target="shell_command:echo hello"') &&
        line.includes('state="running"'),
    ),
  );
});
