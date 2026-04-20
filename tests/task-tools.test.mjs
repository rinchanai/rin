import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const taskIndex = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "task", "index.js")).href,
);

function getTaskTool(name) {
  const tools = [];
  taskIndex.default({
    registerTool(tool) {
      tools.push(tool);
    },
  });
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool);
  return tool;
}

test("save_task exposes in-place update id and dedicated auto-reuse semantics", () => {
  const saveTool = getTaskTool("save_task");
  assert.equal(saveTool.parameters.properties.id.type, "string");
  assert.equal(
    saveTool.parameters.properties.session.properties.sessionFile.type,
    "string",
  );
  assert.match(
    String(
      saveTool.parameters.properties.session.properties.sessionFile.description || "",
    ),
    /first run creates a dedicated session automatically/,
  );
  assert.match(
    String(
      saveTool.parameters.properties.session.properties.sessionFile.description || "",
    ),
    /later runs reuse it/,
  );
});

test("get_task returns a requested task instead of falling back to 'No scheduled tasks'", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-task-runtime-"));
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: {
              task: {
                id: "cron_demo",
                name: "Demo Task",
                enabled: true,
                trigger: { kind: "interval", intervalMs: 60_000 },
                session: { mode: "dedicated" },
                target: { kind: "agent_prompt", prompt: "hello" },
                nextRunAt: "2026-04-18T00:00:00.000Z",
              },
            },
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const getTool = getTaskTool("get_task");

  const previousSocketPath = process.env.RIN_DAEMON_SOCKET_PATH;
  process.env.RIN_DAEMON_SOCKET_PATH = socketPath;
  try {
    const result = await getTool.execute(
      "tool-1",
      { taskId: "cron_demo" },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => undefined,
          getSessionId: () => undefined,
          getSessionName: () => undefined,
        },
      },
    );
    assert.match(String(result.content?.[0]?.text || ""), /cron_demo \(Demo Task\)/);
    assert.doesNotMatch(String(result.content?.[0]?.text || ""), /No scheduled tasks\./);
  } finally {
    process.env.RIN_DAEMON_SOCKET_PATH = previousSocketPath;
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("get_task respects RIN_DAEMON_SOCKET_PATH over legacy runtime dir lookup", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-task-runtime-"));
  const explicitSocketDir = path.join(runtimeDir, "explicit-daemon");
  const socketPath = path.join(explicitSocketDir, "daemon.sock");
  await fs.mkdir(explicitSocketDir, { recursive: true });

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: {
              task: {
                id: "cron_env_socket",
                enabled: true,
                trigger: { kind: "once", runAt: "2026-04-18T00:00:00.000Z" },
                session: { mode: "dedicated" },
                target: { kind: "agent_prompt", prompt: "hello" },
                nextRunAt: "2026-04-18T00:00:00.000Z",
              },
            },
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const getTool = getTaskTool("get_task");

  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const previousSocketPath = process.env.RIN_DAEMON_SOCKET_PATH;
  process.env.XDG_RUNTIME_DIR = path.join(runtimeDir, "wrong-runtime-dir");
  process.env.RIN_DAEMON_SOCKET_PATH = socketPath;
  try {
    const result = await getTool.execute(
      "tool-explicit-socket",
      { taskId: "cron_env_socket" },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => undefined,
          getSessionId: () => undefined,
          getSessionName: () => undefined,
        },
      },
    );
    assert.match(String(result.content?.[0]?.text || ""), /cron_env_socket/);
  } finally {
    process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    process.env.RIN_DAEMON_SOCKET_PATH = previousSocketPath;
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("get_task without taskId lists scheduled tasks via cron_list_tasks", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-task-runtime-"));
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        requests.push(payload);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: {
              tasks: [
                {
                  id: "cron_alpha",
                  enabled: true,
                  trigger: { kind: "once", runAt: "2026-04-18T00:00:00.000Z" },
                  session: { mode: "dedicated" },
                  target: { kind: "agent_prompt", prompt: "alpha" },
                  nextRunAt: "2026-04-18T00:00:00.000Z",
                },
                {
                  id: "cron_beta",
                  name: "Beta Task",
                  enabled: false,
                  trigger: { kind: "cron", expression: "0 * * * *" },
                  session: { mode: "current", sessionFile: "/tmp/demo.jsonl" },
                  target: { kind: "shell_command", command: "echo beta" },
                },
              ],
            },
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const getTool = getTaskTool("get_task");

  const previousSocketPath = process.env.RIN_DAEMON_SOCKET_PATH;
  process.env.RIN_DAEMON_SOCKET_PATH = socketPath;
  try {
    const result = await getTool.execute(
      "tool-2",
      {},
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => undefined,
          getSessionId: () => undefined,
          getSessionName: () => undefined,
        },
      },
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].type, "cron_list_tasks");
    assert.match(String(result.content?.[0]?.text || ""), /cron_alpha/);
    assert.match(String(result.content?.[0]?.text || ""), /cron_beta \(Beta Task\)/);
    assert.match(String(result.content?.[0]?.text || ""), /disabled/);
    assert.doesNotMatch(String(result.content?.[0]?.text || ""), /No scheduled tasks\./);
  } finally {
    process.env.RIN_DAEMON_SOCKET_PATH = previousSocketPath;
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("save_task only auto-binds valid current chat session names", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-task-runtime-"));
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        requests.push(payload);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: { task: payload.task },
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const saveTool = getTaskTool("save_task");

  const previousSocketPath = process.env.RIN_DAEMON_SOCKET_PATH;
  process.env.RIN_DAEMON_SOCKET_PATH = socketPath;
  try {
    await saveTool.execute(
      "tool-invalid",
      {
        trigger: { kind: "once", runAt: "2026-04-18T00:00:00.000Z" },
        target: { kind: "agent_prompt", prompt: "hello" },
      },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => undefined,
          getSessionId: () => undefined,
          getSessionName: () => "telegram:1",
        },
      },
    );
    await saveTool.execute(
      "tool-valid",
      {
        trigger: { kind: "once", runAt: "2026-04-18T00:00:00.000Z" },
        target: { kind: "agent_prompt", prompt: "hello" },
      },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => undefined,
          getSessionId: () => undefined,
          getSessionName: () => "telegram/777:1",
        },
      },
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0].type, "cron_upsert_task");
    assert.equal(requests[0].defaults?.chatKey, undefined);
    assert.equal(requests[0].task?.chatKey, undefined);
    assert.equal(requests[1].defaults?.chatKey, "telegram/777:1");
    assert.equal(requests[1].task?.chatKey, "telegram/777:1");
  } finally {
    process.env.RIN_DAEMON_SOCKET_PATH = previousSocketPath;
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("save_task normalizes prompt and shell targets before sending them to the daemon", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-task-runtime-"));
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        requests.push(payload);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: { task: payload.task },
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const saveTool = getTaskTool("save_task");

  const previousSocketPath = process.env.RIN_DAEMON_SOCKET_PATH;
  process.env.RIN_DAEMON_SOCKET_PATH = socketPath;
  try {
    await saveTool.execute(
      "tool-agent",
      {
        trigger: { kind: "once", runAt: "2026-04-18T00:00:00.000Z" },
        target: { kind: "agent_prompt", prompt: "  hello world  " },
      },
      undefined,
      undefined,
      {},
    );
    await saveTool.execute(
      "tool-shell",
      {
        chatKey: null,
        trigger: { kind: "once", runAt: "2026-04-18T00:00:00.000Z" },
        session: { mode: "current", sessionFile: "/tmp/demo.jsonl" },
        target: { kind: "shell_command", command: "echo hello" },
      },
      undefined,
      undefined,
      {},
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0].task?.session?.mode, "dedicated");
    assert.equal(requests[0].task?.target?.kind, "agent_prompt");
    assert.equal(requests[0].task?.target?.prompt, "hello world");
    assert.equal(requests[1].task?.chatKey, null);
    assert.equal(requests[1].task?.session?.mode, "current");
    assert.equal(requests[1].task?.session?.sessionFile, "/tmp/demo.jsonl");
    assert.equal(requests[1].task?.target?.kind, "shell_command");
    assert.equal(requests[1].task?.target?.command, "echo hello");
  } finally {
    process.env.RIN_DAEMON_SOCKET_PATH = previousSocketPath;
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("manage_task maps public actions to daemon task commands", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-task-runtime-"));
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        requests.push(payload);
        const data =
          payload.type === "cron_delete_task"
            ? { deleted: true }
            : {
                task: {
                  id: payload.taskId,
                  enabled: payload.type === "cron_resume_task",
                  trigger: { kind: "once", runAt: "2026-04-18T00:00:00.000Z" },
                  session: { mode: "dedicated" },
                  target: { kind: "agent_prompt", prompt: "hello" },
                  nextRunAt: "2026-04-18T00:00:00.000Z",
                },
              };
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data,
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const manageTool = getTaskTool("manage_task");

  const previousSocketPath = process.env.RIN_DAEMON_SOCKET_PATH;
  process.env.RIN_DAEMON_SOCKET_PATH = socketPath;
  try {
    const deleted = await manageTool.execute(
      "tool-delete",
      { action: "delete", taskId: "cron_demo" },
      undefined,
      undefined,
      {},
    );
    const paused = await manageTool.execute(
      "tool-pause",
      { action: "pause", taskId: "cron_demo" },
      undefined,
      undefined,
      {},
    );
    const resumed = await manageTool.execute(
      "tool-resume",
      { action: "resume", taskId: "cron_demo" },
      undefined,
      undefined,
      {},
    );

    assert.deepEqual(
      requests.map((request) => request.type),
      ["cron_delete_task", "cron_pause_task", "cron_resume_task"],
    );
    assert.match(String(deleted.content?.[0]?.text || ""), /Deleted task: cron_demo/);
    assert.match(String(paused.content?.[0]?.text || ""), /disabled/);
    assert.match(String(resumed.content?.[0]?.text || ""), /next=2026-04-18T00:00:00.000Z/);
  } finally {
    process.env.RIN_DAEMON_SOCKET_PATH = previousSocketPath;
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
