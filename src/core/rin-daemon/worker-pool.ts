import net from "node:net";
import { spawn } from "node:child_process";

import { parseJsonl } from "../rin-lib/common.js";
import { isSessionScopedCommand } from "../rin-lib/rpc.js";

export type ConnectionState = {
  socket: net.Socket;
  clientBuffer: string;
  attachedWorker?: WorkerHandle;
};

export type WorkerHandle = {
  id: string;
  child: ReturnType<typeof spawn>;
  stdoutBuffer: { buffer: string };
  stderrBuffer: { buffer: string };
  connections: Set<ConnectionState>;
  pendingResponses: Map<string, ConnectionState>;
  sessionFile?: string;
  sessionId?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  lastUsedAt: number;
  keepAliveUntil: number;
};

type SessionSelector = {
  sessionFile?: string;
  sessionId?: string;
};

function writeLine(socket: net.Socket, payload: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
}

export class WorkerPool {
  private workers = new Set<WorkerHandle>();
  private workersBySessionFile = new Map<string, WorkerHandle>();
  private workersBySessionId = new Map<string, WorkerHandle>();
  private catalogWorker: WorkerHandle | undefined;
  private workerSeq = 0;

  constructor(
    private options: {
      workerPath: string;
      cwd: string;
      maxWorkers: number;
      idleTtlMs: number;
      onWorkerSpawn?: (
        requester: ConnectionState | undefined,
        worker: WorkerHandle,
      ) => void;
    },
  ) {}

  detachWorker(connection: ConnectionState) {
    const worker = connection.attachedWorker;
    if (!worker) return;
    worker.connections.delete(connection);
    connection.attachedWorker = undefined;
    worker.lastUsedAt = Date.now();
    worker.keepAliveUntil = Math.max(
      worker.keepAliveUntil,
      Date.now() + 10_000,
    );
  }

  destroyWorker(worker: WorkerHandle) {
    if (!this.workers.has(worker)) return;
    this.workers.delete(worker);
    if (this.catalogWorker === worker) this.catalogWorker = undefined;
    this.deleteWorkerSessionRefs(worker);
    for (const connection of Array.from(worker.connections)) {
      if (connection.attachedWorker === worker)
        connection.attachedWorker = undefined;
      worker.connections.delete(connection);
      writeLine(connection.socket, {
        type: "worker_exit",
        code: null,
        signal: "SIGTERM",
      });
    }
    try {
      worker.child.stdin.end();
    } catch {}
    try {
      worker.child.stdout.destroy();
    } catch {}
    try {
      worker.child.stderr.destroy();
    } catch {}
    try {
      worker.child.kill("SIGTERM");
    } catch {}
  }

  evictDetachedWorkers() {
    const now = Date.now();
    const detached = Array.from(this.workers)
      .filter(
        (worker) =>
          worker.connections.size === 0 &&
          !worker.isStreaming &&
          !worker.isCompacting &&
          now >= worker.keepAliveUntil,
      )
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    for (const worker of detached) {
      if (
        this.workers.size <= this.options.maxWorkers &&
        now - worker.lastUsedAt < this.options.idleTtlMs
      )
        break;
      this.destroyWorker(worker);
    }
  }

  getCatalogWorker() {
    if (!this.catalogWorker || !this.workers.has(this.catalogWorker)) {
      this.catalogWorker = this.createWorker();
    }
    return this.catalogWorker;
  }

  requestWorker(
    worker: WorkerHandle,
    connection: ConnectionState,
    command: any,
    attach: boolean,
  ) {
    if (attach) this.attachWorker(connection, worker);
    worker.lastUsedAt = Date.now();
    worker.keepAliveUntil = Math.max(
      worker.keepAliveUntil,
      Date.now() + 10_000,
    );
    if (command?.id)
      worker.pendingResponses.set(String(command.id), connection);
    worker.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  forwardToWorker(
    connection: ConnectionState,
    worker: WorkerHandle,
    command: any,
  ) {
    this.requestWorker(worker, connection, command, true);
  }

  resolveWorkerForCommand(connection: ConnectionState, command: any) {
    const type = String(command?.type || "unknown");
    const selector = this.getSessionSelector(command);

    if (type === "new_session") {
      return this.createWorker(connection);
    }

    if (type === "switch_session") {
      const wanted =
        selector.sessionFile ||
        (typeof command?.sessionPath === "string" ? command.sessionPath : "");
      const existing = this.findWorkerBySelector({ sessionFile: wanted });
      return existing || this.createWorker(connection);
    }

    if (type === "attach_session") {
      return this.findWorkerBySelector(selector);
    }

    const selectedWorker = this.findWorkerBySelector(selector);
    if (selectedWorker) return selectedWorker;
    if (connection.attachedWorker) return connection.attachedWorker;
    if (isSessionScopedCommand(type)) return undefined;
    return undefined;
  }

  getStatusSnapshot() {
    return {
      workerCount: this.workers.size,
      catalogWorkerId:
        this.catalogWorker && this.workers.has(this.catalogWorker)
          ? this.catalogWorker.id
          : undefined,
      workers: Array.from(this.workers).map((worker) => ({
        id: worker.id,
        pid: worker.child.pid ?? null,
        sessionFile: worker.sessionFile,
        sessionId: worker.sessionId,
        attachedConnections: worker.connections.size,
        pendingResponses: worker.pendingResponses.size,
        isStreaming: worker.isStreaming,
        isCompacting: worker.isCompacting,
        lastUsedAt: worker.lastUsedAt,
        keepAliveUntil: worker.keepAliveUntil,
        role: this.catalogWorker === worker ? "catalog" : "session",
      })),
    };
  }

  destroyAll() {
    for (const worker of Array.from(this.workers)) {
      this.destroyWorker(worker);
    }
  }

  private updateWorkerMetadata(worker: WorkerHandle, payload: any) {
    if (!payload || typeof payload !== "object") return;
    worker.lastUsedAt = Date.now();

    if (
      payload.type === "response" &&
      payload.command === "get_state" &&
      payload.success === true
    ) {
      const data = payload.data || {};
      this.setWorkerSessionRefs(worker, {
        sessionFile:
          typeof data.sessionFile === "string" && data.sessionFile
            ? data.sessionFile
            : undefined,
        sessionId:
          typeof data.sessionId === "string" && data.sessionId
            ? data.sessionId
            : undefined,
      });
      worker.isStreaming = Boolean(data.isStreaming);
      worker.isCompacting = Boolean(data.isCompacting);
      return;
    }

    if (payload.type === "agent_start") {
      worker.isStreaming = true;
      worker.keepAliveUntil = Math.max(
        worker.keepAliveUntil,
        Date.now() + 30_000,
      );
    }
    if (payload.type === "agent_end") {
      worker.isStreaming = false;
      worker.keepAliveUntil = Math.max(
        worker.keepAliveUntil,
        Date.now() + 10_000,
      );
    }
    if (payload.type === "compaction_start") {
      worker.isCompacting = true;
      worker.keepAliveUntil = Math.max(
        worker.keepAliveUntil,
        Date.now() + 30_000,
      );
    }
    if (payload.type === "compaction_end") {
      worker.isCompacting = false;
      worker.keepAliveUntil = Math.max(
        worker.keepAliveUntil,
        Date.now() + 10_000,
      );
    }
    if (payload.type === "rpc_turn_event" && payload.event === "complete") {
      this.setWorkerSessionRefs(worker, {
        sessionFile:
          typeof payload.sessionFile === "string" && payload.sessionFile
            ? payload.sessionFile
            : undefined,
        sessionId:
          typeof payload.sessionId === "string" && payload.sessionId
            ? payload.sessionId
            : undefined,
      });
    }
  }

  private createWorker(requester?: ConnectionState) {
    const child = spawn(process.execPath, [this.options.workerPath], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const worker: WorkerHandle = {
      id: `worker_${++this.workerSeq}`,
      child,
      stdoutBuffer: { buffer: "" },
      stderrBuffer: { buffer: "" },
      connections: new Set(),
      pendingResponses: new Map(),
      isStreaming: false,
      isCompacting: false,
      lastUsedAt: Date.now(),
      keepAliveUntil: Date.now(),
    };
    this.workers.add(worker);

    child.on("spawn", () => {
      this.options.onWorkerSpawn?.(requester, worker);
    });

    child.stdout.on("data", (chunk) => {
      parseJsonl(String(chunk), worker.stdoutBuffer, (line) => {
        let payload: any;
        try {
          payload = JSON.parse(line);
        } catch {
          for (const connection of worker.connections) {
            if (!connection.socket.destroyed)
              connection.socket.write(`${line}\n`);
          }
          return;
        }

        this.updateWorkerMetadata(worker, payload);

        if (
          payload?.type === "response" &&
          payload.id &&
          worker.pendingResponses.has(String(payload.id))
        ) {
          const connection = worker.pendingResponses.get(String(payload.id))!;
          worker.pendingResponses.delete(String(payload.id));
          writeLine(connection.socket, payload);
          return;
        }

        for (const connection of worker.connections) {
          writeLine(connection.socket, payload);
        }
      });
    });

    child.stderr.on("data", (chunk) => {
      parseJsonl(String(chunk), worker.stderrBuffer, (line) => {
        for (const connection of worker.connections) {
          writeLine(connection.socket, { type: "stderr", line });
        }
      });
    });

    child.on("exit", (code, signal) => {
      this.deleteWorkerSessionRefs(worker);
      this.workers.delete(worker);
      for (const connection of Array.from(worker.connections)) {
        if (connection.attachedWorker === worker)
          connection.attachedWorker = undefined;
        writeLine(connection.socket, {
          type: "worker_exit",
          code: code ?? null,
          signal: signal ?? null,
        });
      }
      worker.connections.clear();
      worker.pendingResponses.clear();
    });

    return worker;
  }

  private attachWorker(connection: ConnectionState, worker: WorkerHandle) {
    if (connection.attachedWorker === worker) return;
    this.detachWorker(connection);
    connection.attachedWorker = worker;
    worker.connections.add(connection);
    worker.lastUsedAt = Date.now();
  }

  private getSessionSelector(command: any): SessionSelector {
    const sessionFile =
      typeof command?.sessionFile === "string" && command.sessionFile
        ? command.sessionFile
        : typeof command?.sessionPath === "string" && command.sessionPath
          ? command.sessionPath
          : undefined;
    const sessionId =
      typeof command?.sessionId === "string" && command.sessionId
        ? command.sessionId
        : undefined;
    return { sessionFile, sessionId };
  }

  private findWorkerBySelector(selector: SessionSelector) {
    if (
      selector.sessionFile &&
      this.workersBySessionFile.has(selector.sessionFile)
    ) {
      return this.workersBySessionFile.get(selector.sessionFile);
    }
    if (selector.sessionId && this.workersBySessionId.has(selector.sessionId)) {
      return this.workersBySessionId.get(selector.sessionId);
    }
    return undefined;
  }

  private deleteWorkerSessionRefs(worker: WorkerHandle) {
    if (
      worker.sessionFile &&
      this.workersBySessionFile.get(worker.sessionFile) === worker
    ) {
      this.workersBySessionFile.delete(worker.sessionFile);
    }
    if (
      worker.sessionId &&
      this.workersBySessionId.get(worker.sessionId) === worker
    ) {
      this.workersBySessionId.delete(worker.sessionId);
    }
    worker.sessionFile = undefined;
    worker.sessionId = undefined;
  }

  private setWorkerSessionRefs(worker: WorkerHandle, next: SessionSelector) {
    if (
      worker.sessionFile &&
      this.workersBySessionFile.get(worker.sessionFile) === worker &&
      worker.sessionFile !== next.sessionFile
    ) {
      this.workersBySessionFile.delete(worker.sessionFile);
    }
    if (
      worker.sessionId &&
      this.workersBySessionId.get(worker.sessionId) === worker &&
      worker.sessionId !== next.sessionId
    ) {
      this.workersBySessionId.delete(worker.sessionId);
    }
    worker.sessionFile = next.sessionFile;
    worker.sessionId = next.sessionId;
    if (worker.sessionFile)
      this.workersBySessionFile.set(worker.sessionFile, worker);
    if (worker.sessionId) this.workersBySessionId.set(worker.sessionId, worker);
  }
}
