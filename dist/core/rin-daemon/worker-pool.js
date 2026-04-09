import { spawn } from "node:child_process";
import { parseJsonl } from "../rin-lib/common.js";
import { isSessionScopedCommand } from "../rin-lib/rpc.js";
function writeLine(socket, payload) {
    if (!socket.destroyed)
        socket.write(`${JSON.stringify(payload)}\n`);
}
export class WorkerPool {
    options;
    workers = new Set();
    workersBySessionFile = new Map();
    workersBySessionId = new Map();
    workerSeq = 0;
    shuttingDown = false;
    constructor(options) {
        this.options = options;
    }
    detachWorker(connection) {
        const worker = connection.attachedWorker;
        if (!worker)
            return;
        worker.connections.delete(connection);
        connection.attachedWorker = undefined;
        worker.lastUsedAt = Date.now();
        this.maybeReleaseWorker(worker);
    }
    terminateWorkerGracefully(worker) {
        if (!this.workers.has(worker) || worker.gracefulShutdownRequested)
            return;
        worker.gracefulShutdownRequested = true;
        try {
            worker.child.stdin.write(`${JSON.stringify({ type: "shutdown_session" })}\n`);
        }
        catch {
            this.destroyWorker(worker);
        }
    }
    destroyWorker(worker) {
        if (!this.workers.has(worker))
            return;
        this.workers.delete(worker);
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
        }
        catch { }
        try {
            worker.child.stdout.destroy();
        }
        catch { }
        try {
            worker.child.stderr.destroy();
        }
        catch { }
        try {
            worker.child.kill("SIGTERM");
        }
        catch { }
    }
    evictDetachedWorkers() {
        for (const worker of Array.from(this.workers)) {
            this.maybeReleaseWorker(worker);
        }
    }
    requestWorker(worker, connection, command, attach) {
        if (attach)
            this.attachWorker(connection, worker);
        worker.lastUsedAt = Date.now();
        worker.releaseRequested = false;
        if (command?.id)
            worker.pendingResponses.set(String(command.id), connection);
        worker.child.stdin.write(`${JSON.stringify(command)}\n`);
    }
    forwardToWorker(connection, worker, command) {
        this.requestWorker(worker, connection, command, true);
    }
    resolveWorkerForCommand(connection, command) {
        const type = String(command?.type || "unknown");
        const selector = this.getSessionSelector(command);
        if (type === "new_session") {
            return this.createWorker(connection);
        }
        if (type === "switch_session") {
            const wanted = selector.sessionFile ||
                (typeof command?.sessionPath === "string" ? command.sessionPath : "");
            const existing = this.findWorkerBySelector({ sessionFile: wanted });
            return existing || this.createWorker(connection);
        }
        if (type === "attach_session") {
            return this.findWorkerBySelector(selector);
        }
        const selectedWorker = this.findWorkerBySelector(selector);
        if (selectedWorker)
            return selectedWorker;
        if (connection.attachedWorker)
            return connection.attachedWorker;
        if (isSessionScopedCommand(type))
            return undefined;
        return undefined;
    }
    getStatusSnapshot() {
        return {
            workerCount: this.workers.size,
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
                releaseRequested: worker.releaseRequested,
                role: "session",
            })),
        };
    }
    destroyAll() {
        for (const worker of Array.from(this.workers)) {
            this.destroyWorker(worker);
        }
    }
    beginShutdown() {
        this.shuttingDown = true;
        for (const worker of Array.from(this.workers)) {
            for (const connection of Array.from(worker.connections)) {
                if (connection.attachedWorker === worker)
                    connection.attachedWorker = undefined;
                worker.connections.delete(connection);
            }
            this.maybeReleaseWorker(worker);
        }
    }
    getInterruptedSessionSelectors() {
        return Array.from(this.workers)
            .filter((worker) => worker.isStreaming && worker.sessionFile)
            .map((worker) => ({
            sessionFile: worker.sessionFile,
        }));
    }
    resumeInterruptedSession(sessionFile) {
        const worker = this.createWorker();
        this.setWorkerSessionRefs(worker, { sessionFile, sessionId: undefined });
        worker.child.stdin.write(`${JSON.stringify({ type: "switch_session", sessionPath: sessionFile })}\n`);
        worker.child.stdin.write(`${JSON.stringify({ type: "resume_interrupted_turn", source: "daemon-restart" })}\n`);
    }
    async shutdown(graceMs) {
        this.beginShutdown();
        const deadline = Date.now() + Math.max(0, graceMs);
        while (this.workers.size > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            for (const worker of Array.from(this.workers)) {
                this.maybeReleaseWorker(worker);
            }
        }
        const interrupted = this.getInterruptedSessionSelectors();
        this.destroyAll();
        return interrupted;
    }
    updateWorkerMetadata(worker, payload) {
        if (!payload || typeof payload !== "object")
            return;
        worker.lastUsedAt = Date.now();
        if (payload.type === "response" && payload.success === true) {
            const data = payload.data || {};
            if (typeof data.sessionFile === "string" ||
                typeof data.sessionId === "string") {
                this.setWorkerSessionRefs(worker, {
                    sessionFile: typeof data.sessionFile === "string" && data.sessionFile
                        ? data.sessionFile
                        : undefined,
                    sessionId: typeof data.sessionId === "string" && data.sessionId
                        ? data.sessionId
                        : undefined,
                });
            }
            if (payload.command === "get_state") {
                worker.isStreaming = Boolean(data.isStreaming);
                worker.isCompacting = Boolean(data.isCompacting);
                this.maybeReleaseWorker(worker);
                return;
            }
        }
        if (payload.type === "agent_start") {
            worker.isStreaming = true;
        }
        if (payload.type === "agent_end") {
            worker.isStreaming = false;
            this.maybeReleaseWorker(worker);
        }
        if (payload.type === "compaction_start") {
            worker.isCompacting = true;
        }
        if (payload.type === "compaction_end") {
            worker.isCompacting = false;
            this.maybeReleaseWorker(worker);
        }
        if (payload.type === "rpc_turn_event" && payload.event === "complete") {
            this.setWorkerSessionRefs(worker, {
                sessionFile: typeof payload.sessionFile === "string" && payload.sessionFile
                    ? payload.sessionFile
                    : undefined,
                sessionId: typeof payload.sessionId === "string" && payload.sessionId
                    ? payload.sessionId
                    : undefined,
            });
        }
    }
    createWorker(requester) {
        if (this.shuttingDown) {
            throw new Error("rin_daemon_shutting_down");
        }
        const child = spawn(process.execPath, [this.options.workerPath], {
            cwd: this.options.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });
        const worker = {
            id: `worker_${++this.workerSeq}`,
            child,
            stdoutBuffer: { buffer: "" },
            stderrBuffer: { buffer: "" },
            connections: new Set(),
            pendingResponses: new Map(),
            isStreaming: false,
            isCompacting: false,
            lastUsedAt: Date.now(),
            releaseRequested: false,
            gracefulShutdownRequested: false,
        };
        this.workers.add(worker);
        child.on("spawn", () => {
            this.options.onWorkerSpawn?.(requester, worker);
        });
        child.stdout.on("data", (chunk) => {
            parseJsonl(String(chunk), worker.stdoutBuffer, (line) => {
                let payload;
                try {
                    payload = JSON.parse(line);
                }
                catch {
                    for (const connection of worker.connections) {
                        if (!connection.socket.destroyed)
                            connection.socket.write(`${line}\n`);
                    }
                    return;
                }
                this.updateWorkerMetadata(worker, payload);
                if (payload?.type === "response" &&
                    payload.id &&
                    worker.pendingResponses.has(String(payload.id))) {
                    const connection = worker.pendingResponses.get(String(payload.id));
                    worker.pendingResponses.delete(String(payload.id));
                    writeLine(connection.socket, payload);
                    this.maybeReleaseWorker(worker);
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
            for (const connection of new Set(worker.pendingResponses.values())) {
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
    attachWorker(connection, worker) {
        if (connection.attachedWorker === worker)
            return;
        this.detachWorker(connection);
        connection.attachedWorker = worker;
        worker.connections.add(connection);
        worker.lastUsedAt = Date.now();
        worker.releaseRequested = false;
    }
    maybeReleaseWorker(worker) {
        if (!this.workers.has(worker))
            return;
        if (worker.gracefulShutdownRequested)
            return;
        if (!this.shuttingDown && worker.connections.size > 0) {
            worker.releaseRequested = false;
            return;
        }
        if (worker.pendingResponses.size > 0) {
            return;
        }
        if (worker.isStreaming || worker.isCompacting) {
            return;
        }
        if (this.shuttingDown || worker.releaseRequested) {
            this.destroyWorker(worker);
            return;
        }
        const gcIdleMs = Math.max(0, Number(this.options.gcIdleMs ?? 15 * 60_000));
        if (Date.now() - worker.lastUsedAt >= gcIdleMs) {
            this.destroyWorker(worker);
        }
    }
    getSessionSelector(command) {
        const sessionFile = typeof command?.sessionFile === "string" && command.sessionFile
            ? command.sessionFile
            : typeof command?.sessionPath === "string" && command.sessionPath
                ? command.sessionPath
                : undefined;
        const sessionId = typeof command?.sessionId === "string" && command.sessionId
            ? command.sessionId
            : undefined;
        return { sessionFile, sessionId };
    }
    findWorkerBySelector(selector) {
        if (selector.sessionFile &&
            this.workersBySessionFile.has(selector.sessionFile)) {
            return this.workersBySessionFile.get(selector.sessionFile);
        }
        if (selector.sessionId && this.workersBySessionId.has(selector.sessionId)) {
            return this.workersBySessionId.get(selector.sessionId);
        }
        return undefined;
    }
    deleteWorkerSessionRefs(worker) {
        if (worker.sessionFile &&
            this.workersBySessionFile.get(worker.sessionFile) === worker) {
            this.workersBySessionFile.delete(worker.sessionFile);
        }
        if (worker.sessionId &&
            this.workersBySessionId.get(worker.sessionId) === worker) {
            this.workersBySessionId.delete(worker.sessionId);
        }
        worker.sessionFile = undefined;
        worker.sessionId = undefined;
    }
    setWorkerSessionRefs(worker, next) {
        if (worker.sessionFile &&
            this.workersBySessionFile.get(worker.sessionFile) === worker &&
            worker.sessionFile !== next.sessionFile) {
            this.workersBySessionFile.delete(worker.sessionFile);
        }
        if (worker.sessionId &&
            this.workersBySessionId.get(worker.sessionId) === worker &&
            worker.sessionId !== next.sessionId) {
            this.workersBySessionId.delete(worker.sessionId);
        }
        worker.sessionFile = next.sessionFile;
        worker.sessionId = next.sessionId;
        if (worker.sessionFile)
            this.workersBySessionFile.set(worker.sessionFile, worker);
        if (worker.sessionId)
            this.workersBySessionId.set(worker.sessionId, worker);
    }
}
