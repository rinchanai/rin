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

test("save_task exposes in-place update id and dedicated default read-and-burn semantics", () => {
  const tools = [];
  taskIndex.default({
    registerTool(tool) {
      tools.push(tool);
    },
  });
  const saveTool = tools.find((tool) => tool.name === "save_task");
  assert.ok(saveTool);
  assert.equal(saveTool.parameters.properties.id.type, "string");
  assert.equal(
    saveTool.parameters.properties.session.properties.sessionFile.type,
    "string",
  );
  assert.match(
    String(
      saveTool.parameters.properties.session.properties.sessionFile.description || "",
    ),
    /read-and-burn by default/,
  );
  assert.match(
    String(
      saveTool.parameters.properties.session.properties.sessionFile.description || "",
    ),
    /seed or resume a persistent dedicated session explicitly/,
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

  const tools = [];
  taskIndex.default({
    registerTool(tool) {
      tools.push(tool);
    },
  });
  const getTool = tools.find((tool) => tool.name === "get_task");
  assert.ok(getTool);

  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
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
    process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
