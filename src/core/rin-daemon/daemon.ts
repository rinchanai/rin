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
import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { response } from "../rin-lib/rpc.js";
import { resolveRuntimeProfile } from "../rin-lib/runtime.js";
import { CronScheduler } from "./cron.js";
import { loadRestartState, saveRestartState } from "./restart-state.js";
import { handleDaemonSelfCommand } from "./self-handle.js";
import { writeLine } from "./socket.js";
import { ConnectionState, WorkerPool } from "./worker-pool.js";

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
    gcIdleMs: Number(process.env.RIN_WORKER_GC_IDLE_MS || 15 * 60_000),
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
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
  }

  const selfHandleCommand = async (
    connection: ConnectionState,
    command: any,
  ) => {
    return await handleDaemonSelfCommand({
      connection,
      command,
      socketPath,
      runtime,
      additionalExtensionPaths: options.additionalExtensionPaths,
      workerPool,
      cronScheduler,
      sessionManagerModulePromise,
    });
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
