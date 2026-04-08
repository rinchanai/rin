#!/usr/bin/env node
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  bridgeDaemonSocketPath,
  defaultDaemonSocketPath,
  safeString,
} from "../rin-lib/common.js";
import type { RinRpcCommandType } from "../rin-lib/rpc-types.js";
import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { getKoishiSidecarStatus } from "../rin-koishi/service.js";
import { emptySessionState, response } from "../rin-lib/rpc.js";
import { resolveRuntimeProfile } from "../rin-lib/runtime.js";
import { getSearxngSidecarStatus } from "../rin-web-search/service.js";
import { CronScheduler } from "./cron.js";
import {
  getCatalogOAuthState,
  listCatalogCommands,
  listCatalogModels,
} from "./catalog.js";
import { ConnectionState, WorkerPool } from "./worker-pool.js";

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeLine(socket: net.Socket, payload: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
}

export async function startDaemon(
  options: {
    socketPath?: string;
    workerPath?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const socketPath =
    options.socketPath || process.argv[2] || defaultDaemonSocketPath();
  const bridgeSocketPath = bridgeDaemonSocketPath(
    process.env.RIN_DIR || resolveRuntimeProfile().agentDir,
  );
  const workerPath =
    options.workerPath ||
    process.env.RIN_WORKER_PATH ||
    path.join(path.dirname(new URL(import.meta.url).pathname), "worker.js");
  const runtime = resolveRuntimeProfile();
  const sessionManagerModulePromise = loadRinSessionManagerModule();
  const workerPool = new WorkerPool({
    workerPath,
    cwd: runtime.cwd,
    onWorkerSpawn: (requester, worker) => {
      if (requester)
        writeLine(requester.socket, {
          type: "ui",
          name: "worker_spawned",
          payload: { pid: worker.child.pid ?? null },
        });
    },
  });

  const cronScheduler = new CronScheduler({
    agentDir: runtime.agentDir,
    cwd: runtime.cwd,
    additionalExtensionPaths: options.additionalExtensionPaths,
  });
  cronScheduler.start();

  for (const candidate of [socketPath, bridgeSocketPath]) {
    try {
      fs.rmSync(candidate, { force: true });
    } catch {}
    ensureDir(path.dirname(candidate));
  }

  const hasSessionSelector = (command: any) =>
    Boolean(
      (typeof command?.sessionFile === "string" && command.sessionFile) ||
      (typeof command?.sessionId === "string" && command.sessionId),
    );

  const selfHandleCommand = async (
    connection: ConnectionState,
    command: any,
  ) => {
    const id = command?.id;
    const type = String(command?.type || "unknown") as
      | RinRpcCommandType
      | "unknown";
    const selectorPresent = hasSessionSelector(command);

    if (
      type === "get_state" &&
      !connection.attachedWorker &&
      !selectorPresent
    ) {
      writeLine(
        connection.socket,
        response(id, type, true, emptySessionState()),
      );
      return true;
    }
    if (
      type === "get_messages" &&
      !connection.attachedWorker &&
      !selectorPresent
    ) {
      writeLine(connection.socket, response(id, type, true, { messages: [] }));
      return true;
    }
    if (
      type === "get_session_entries" &&
      !connection.attachedWorker &&
      !selectorPresent
    ) {
      writeLine(connection.socket, response(id, type, true, { entries: [] }));
      return true;
    }
    if (
      type === "get_session_tree" &&
      !connection.attachedWorker &&
      !selectorPresent
    ) {
      writeLine(
        connection.socket,
        response(id, type, true, { tree: [], leafId: null }),
      );
      return true;
    }
    if (
      type === "get_commands" &&
      !connection.attachedWorker &&
      !selectorPresent
    ) {
      writeLine(
        connection.socket,
        response(id, type, true, {
          commands: await listCatalogCommands({
            cwd: runtime.cwd,
            agentDir: runtime.agentDir,
            additionalExtensionPaths: options.additionalExtensionPaths,
          }),
        }),
      );
      return true;
    }
    if (
      type === "get_available_models" &&
      !connection.attachedWorker &&
      !selectorPresent
    ) {
      writeLine(
        connection.socket,
        response(id, type, true, {
          models: await listCatalogModels({
            cwd: runtime.cwd,
            agentDir: runtime.agentDir,
            additionalExtensionPaths: options.additionalExtensionPaths,
          }),
        }),
      );
      return true;
    }
    if (
      type === "get_oauth_state" &&
      !connection.attachedWorker &&
      !selectorPresent
    ) {
      writeLine(
        connection.socket,
        response(
          id,
          type,
          true,
          await getCatalogOAuthState({
            cwd: runtime.cwd,
            agentDir: runtime.agentDir,
            additionalExtensionPaths: options.additionalExtensionPaths,
          }),
        ),
      );
      return true;
    }
    if (type === "list_sessions") {
      const { SessionManager } = await sessionManagerModulePromise;
      const scope = command.scope === "all" ? "all" : "cwd";
      const sessions =
        scope === "all"
          ? await SessionManager.listAll()
          : await SessionManager.list(
              runtime.cwd,
              path.join(
                runtime.agentDir,
                "sessions",
                `--${runtime.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
              ),
            );
      writeLine(connection.socket, response(id, type, true, { sessions }));
      return true;
    }
    if (type === "detach_session") {
      workerPool.detachWorker(connection);
      writeLine(
        connection.socket,
        response(id, type, true, emptySessionState()),
      );
      return true;
    }
    if (type === "rename_session") {
      const { SessionManager } = await sessionManagerModulePromise;
      const name = String(command.name || "").trim();
      if (!name) {
        writeLine(
          connection.socket,
          response(id, type, false, "Session name cannot be empty"),
        );
        return true;
      }
      const manager = SessionManager.open(command.sessionPath);
      manager.appendSessionInfo(name);
      writeLine(connection.socket, response(id, type, true));
      return true;
    }
    if (type === "daemon_status") {
      writeLine(
        connection.socket,
        response(id, type, true, {
          socketPath,
          ...workerPool.getStatusSnapshot(),
          taskCount: cronScheduler.listTasks().length,
          webSearch: getSearxngSidecarStatus(runtime.agentDir),
          koishi: getKoishiSidecarStatus(runtime.agentDir),
        }),
      );
      return true;
    }
    if (type === "cron_list_tasks") {
      writeLine(
        connection.socket,
        response(id, type, true, { tasks: cronScheduler.listTasks() }),
      );
      return true;
    }
    if (type === "cron_get_task") {
      const task = cronScheduler.getTask(String(command.taskId || "").trim());
      writeLine(
        connection.socket,
        response(id, type, Boolean(task), task || "cron_task_not_found"),
      );
      return true;
    }
    if (type === "cron_upsert_task") {
      const task = cronScheduler.upsertTask(
        command.task || {},
        command.defaults || {},
      );
      writeLine(connection.socket, response(id, type, true, { task }));
      return true;
    }
    if (type === "cron_delete_task") {
      const ok = cronScheduler.deleteTask(String(command.taskId || "").trim());
      writeLine(
        connection.socket,
        response(id, type, ok, ok ? { deleted: true } : "cron_task_not_found"),
      );
      return true;
    }
    if (type === "cron_complete_task") {
      const task = cronScheduler.completeTask(
        String(command.taskId || "").trim(),
        String(command.reason || "completed_by_tool"),
      );
      writeLine(connection.socket, response(id, type, true, { task }));
      return true;
    }
    if (type === "cron_pause_task") {
      const task = cronScheduler.pauseTask(String(command.taskId || "").trim());
      writeLine(connection.socket, response(id, type, true, { task }));
      return true;
    }
    if (type === "cron_resume_task") {
      const task = cronScheduler.resumeTask(
        String(command.taskId || "").trim(),
      );
      writeLine(connection.socket, response(id, type, true, { task }));
      return true;
    }
    return false;
  };

  const createSocketServer = () =>
    net.createServer((socket) => {
      const connection: ConnectionState = {
        socket,
        clientBuffer: "",
      };

      socket.on("data", (chunk) => {
        connection.clientBuffer += String(chunk);
        while (true) {
          const idx = connection.clientBuffer.indexOf("\n");
          if (idx < 0) break;
          let line = connection.clientBuffer.slice(0, idx);
          connection.clientBuffer = connection.clientBuffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.trim()) continue;
          (async () => {
            let command: any;
            try {
              command = JSON.parse(line);
            } catch {
              writeLine(
                socket,
                response(undefined, "unknown", false, "invalid_json"),
              );
              return;
            }

            if (await selfHandleCommand(connection, command)) {
              workerPool.evictDetachedWorkers();
              return;
            }

            const worker = workerPool.resolveWorkerForCommand(
              connection,
              command,
            );
            if (!worker) {
              writeLine(
                socket,
                response(
                  command?.id,
                  String(command?.type || "unknown"),
                  false,
                  "rin_no_attached_session",
                ),
              );
              return;
            }

            workerPool.forwardToWorker(connection, worker, command);
            workerPool.evictDetachedWorkers();
          })().catch((error) => {
            writeLine(socket, response(undefined, "unknown", false, error));
          });
        }
      });

      const cleanup = () => {
        workerPool.detachWorker(connection);
        workerPool.evictDetachedWorkers();
      };

      socket.on("close", cleanup);
      socket.on("error", cleanup);
    });

  const servers = [
    { server: createSocketServer(), path: socketPath, chmod: null },
    { server: createSocketServer(), path: bridgeSocketPath, chmod: 0o666 },
  ];

  await Promise.all(
    servers.map(
      ({ server, path: listenPath, chmod }) =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(listenPath, () => {
            server.removeListener("error", reject);
            if (typeof chmod === "number") {
              try {
                fs.chmodSync(listenPath, chmod);
              } catch {}
            }
            resolve();
          });
        }),
    ),
  );

  console.log(`rin daemon listening on ${socketPath}`);
  console.log(`rin daemon bridge listening on ${bridgeSocketPath}`);

  const shutdown = async () => {
    cronScheduler.stop();
    workerPool.destroyAll();
    await Promise.all(
      servers.map(
        ({ server }) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    for (const candidate of [socketPath, bridgeSocketPath]) {
      try {
        fs.rmSync(candidate, { force: true });
      } catch {}
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  await startDaemon();
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    console.error(
      safeString(error && error.message ? error.message : error) ||
        "rin_daemon_failed",
    );
    process.exit(1);
  });
}
