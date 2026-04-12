import { emptySessionState, response } from "../rin-lib/rpc.js";
import type { RinRpcCommandType } from "../rin-lib/rpc-types.js";
import { getKoishiSidecarStatus } from "../rin-koishi/service.js";
import { getSearxngSidecarStatus } from "../rin-web-search/service.js";
import {
  getCatalogOAuthState,
  listCatalogCommands,
  listCatalogModels,
} from "./catalog.js";
import { writeLine } from "./socket.js";

export function hasSessionSelector(command: any) {
  return Boolean(
    (typeof command?.sessionFile === "string" && command.sessionFile) ||
    (typeof command?.sessionId === "string" && command.sessionId),
  );
}

export async function handleDaemonSelfCommand(input: {
  connection: any;
  command: any;
  socketPath: string;
  runtime: { cwd: string; agentDir: string };
  additionalExtensionPaths?: string[];
  workerPool: any;
  cronScheduler: any;
  sessionManagerModulePromise: Promise<any>;
}) {
  const {
    connection,
    command,
    socketPath,
    runtime,
    additionalExtensionPaths,
    workerPool,
    cronScheduler,
    sessionManagerModulePromise,
  } = input;
  const id = command?.id;
  const type = String(command?.type || "unknown") as
    | RinRpcCommandType
    | "unknown";
  const selectorPresent = hasSessionSelector(command);

  if (type === "get_state" && !connection.attachedWorker && !selectorPresent) {
    writeLine(connection.socket, response(id, type, true, emptySessionState()));
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
          additionalExtensionPaths,
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
          additionalExtensionPaths,
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
          additionalExtensionPaths,
        }),
      ),
    );
    return true;
  }
  if (type === "new_session" || type === "switch_session") {
    const previousWorker = connection.attachedWorker;
    const worker = workerPool.resolveWorkerForCommand(connection, command);
    if (!worker) {
      writeLine(
        connection.socket,
        response(id, type, false, "rin_no_attached_session"),
      );
      return true;
    }
    workerPool.forwardToWorker(connection, worker, command);
    if (previousWorker && previousWorker !== worker) {
      workerPool.terminateWorkerGracefully(previousWorker);
    }
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
    workerPool.detachWorker(connection);
    writeLine(connection.socket, response(id, type, true, emptySessionState()));
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
    const task = cronScheduler.resumeTask(String(command.taskId || "").trim());
    writeLine(connection.socket, response(id, type, true, { task }));
    return true;
  }
  return false;
}
