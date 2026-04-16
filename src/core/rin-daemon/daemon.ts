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
import { getChatSidecarStatus } from "../chat/service.js";
import {
  emptySessionState,
  isSessionScopedCommand,
  response,
} from "../rin-lib/rpc.js";
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

function restartStatePath(agentDir: string) {
  return path.join(agentDir, "data", "restart.json");
}

function loadRestartState(agentDir: string) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(restartStatePath(agentDir), "utf8"),
    );
    const pendingResume = Array.isArray(parsed?.pendingResume)
      ? parsed.pendingResume
          .map((item: any) => ({
            sessionFile:
              typeof item?.sessionFile === "string" && item.sessionFile
                ? item.sessionFile
                : undefined,
            resumeTurn: Boolean(item?.resumeTurn),
          }))
          .filter((item: any) => item.sessionFile)
      : [];
    return { pendingResume };
  } catch {
    return { pendingResume: [] };
  }
}

function saveRestartState(
  agentDir: string,
  state: {
    pendingResume: Array<{ sessionFile?: string; resumeTurn?: boolean }>;
  },
) {
  const filePath = restartStatePath(agentDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!state.pendingResume.length) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, pendingResume: state.pendingResume }),
    );
  } catch {}
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
  const restartState = loadRestartState(runtime.agentDir);
  const workerPool = new WorkerPool({
    workerPath,
    cwd: runtime.cwd,
    gcIdleMs: Number(process.env.RIN_WORKER_GC_IDLE_MS || 30_000),
    sweepIntervalMs: Number(process.env.RIN_WORKER_GC_SWEEP_MS || 5_000),
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
    additionalExtensionPaths: options.additionalExtensionPaths,
  });
  cronScheduler.start();

  for (const candidate of [socketPath, bridgeSocketPath]) {
    try {
      fs.rmSync(candidate, { force: true });
    } catch {}
    ensureDir(path.dirname(candidate));
  }

  const getSessionSelector = (command: any) => ({
    sessionFile:
      typeof command?.sessionFile === "string" && command.sessionFile
        ? command.sessionFile
        : typeof command?.sessionPath === "string" && command.sessionPath
          ? command.sessionPath
          : undefined,
    sessionId:
      typeof command?.sessionId === "string" && command.sessionId
        ? command.sessionId
        : undefined,
  });
  const hasSessionSelector = (command: any) => {
    const selector = getSessionSelector(command);
    return Boolean(selector.sessionFile || selector.sessionId);
  };
  const hasSelectedSession = (connection: ConnectionState) =>
    workerPool.hasSelectedSession(connection);

  const selfHandleCommand = async (
    connection: ConnectionState,
    command: any,
  ) => {
    const id = command?.id;
    const type = String(command?.type || "unknown") as
      | RinRpcCommandType
      | "unknown";
    const selectorPresent = hasSessionSelector(command);
    const selectedSessionPresent = hasSelectedSession(connection);

    if (
      type === "get_state" &&
      !connection.attachedWorker &&
      !selectorPresent &&
      !selectedSessionPresent
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
      !selectorPresent &&
      !selectedSessionPresent
    ) {
      writeLine(connection.socket, response(id, type, true, { messages: [] }));
      return true;
    }
    if (
      type === "get_session_entries" &&
      !connection.attachedWorker &&
      !selectorPresent &&
      !selectedSessionPresent
    ) {
      writeLine(connection.socket, response(id, type, true, { entries: [] }));
      return true;
    }
    if (
      type === "get_session_tree" &&
      !connection.attachedWorker &&
      !selectorPresent &&
      !selectedSessionPresent
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
      !selectorPresent &&
      !selectedSessionPresent
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
      !selectorPresent &&
      !selectedSessionPresent
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
      !selectorPresent &&
      !selectedSessionPresent
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
    if (type === "new_session") {
      const worker = workerPool.resolveWorkerForCommand(connection, command);
      if (!worker) {
        writeLine(
          connection.socket,
          response(id, type, false, "rin_no_attached_session"),
        );
        return true;
      }
      workerPool.forwardToWorker(connection, worker, command);
      workerPool.evictDetachedWorkers();
      return true;
    }
    if (
      type === "select_session" ||
      type === "switch_session" ||
      type === "attach_session"
    ) {
      const selector = getSessionSelector(command);
      if (!selector.sessionFile && !selector.sessionId) {
        writeLine(
          connection.socket,
          response(id, type, false, "rin_no_attached_session"),
        );
        return true;
      }
      const worker = await workerPool.selectSession(connection, selector);
      if (!worker) {
        writeLine(
          connection.socket,
          response(id, type, false, "rin_no_attached_session"),
        );
        return true;
      }
      writeLine(connection.socket, response(id, type, true, { cancelled: false }));
      workerPool.evictDetachedWorkers();
      return true;
    }
    if (type === "terminate_session") {
      const target =
        workerPool.resolveWorkerForCommand(connection, command) ||
        connection.attachedWorker;
      if (!target) {
        writeLine(
          connection.socket,
          response(id, type, false, "rin_no_attached_session"),
        );
        return true;
      }
      if (target === connection.attachedWorker) {
        workerPool.detachWorker(connection, { clearSelection: true });
      }
      workerPool.terminateWorkerGracefully(target);
      writeLine(
        connection.socket,
        response(id, type, true, { terminated: true }),
      );
      return true;
    }
    if (type === "list_sessions") {
      const { SessionManager } = await sessionManagerModulePromise;
      const sessions = await SessionManager.listAll();
      writeLine(connection.socket, response(id, type, true, { sessions }));
      return true;
    }
    if (type === "detach_session") {
      workerPool.detachWorker(connection, { clearSelection: true });
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
          chat: getChatSidecarStatus(runtime.agentDir),
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

  const activeSockets = new Set<net.Socket>();

  const createSocketServer = () =>
    net.createServer((socket) => {
      activeSockets.add(socket);
      const dropSocket = () => activeSockets.delete(socket);
      socket.once("close", dropSocket);
      socket.once("error", dropSocket);

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

            let worker = workerPool.resolveWorkerForCommand(
              connection,
              command,
            );
            if (
              !worker &&
              isSessionScopedCommand(String(command?.type || "unknown")) &&
              (hasSessionSelector(command) || hasSelectedSession(connection))
            ) {
              worker = await workerPool.ensureSelectedWorker(
                connection,
                getSessionSelector(command),
              );
            }
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

  const pendingResume = [...restartState.pendingResume];
  restartState.pendingResume = [];
  saveRestartState(runtime.agentDir, restartState);
  for (const item of pendingResume) {
    try {
      if (item.sessionFile) workerPool.restoreSessionWorker(item);
    } catch {
      restartState.pendingResume.push(item);
    }
  }
  saveRestartState(runtime.agentDir, restartState);

  let shuttingDown = false;
  const shutdownGraceMs = Math.max(
    0,
    Number(process.env.RIN_DAEMON_SHUTDOWN_GRACE_MS || 85_000),
  );
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    cronScheduler.stop();
    workerPool.beginShutdown();
    for (const socket of Array.from(activeSockets)) {
      try {
        socket.destroy();
      } catch {}
    }
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
    restartState.pendingResume = await workerPool.shutdown(shutdownGraceMs);
    saveRestartState(runtime.agentDir, restartState);
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
