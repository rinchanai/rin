import { spawn } from "node:child_process";
import { parseJsonl } from "../rin-lib/common.js";
import { isSessionScopedCommand } from "../rin-lib/rpc.js";
function writeLine(socket, payload) {
    if (!socket.destroyed)
        socket.write(`${JSON.stringify(payload)}\n`);
}
function responseError(commandId, commandType, error) {
    return {
        id: commandId,
        type: "response",
        command: commandType,
        success: false,
        error,
    };
}
export class WorkerPool {
    options;
    workers = new Set();
    workersBySessionFile = new Map();
    workersBySessionId = new Map();
    workerSeq = 0;
    internalRequestSeq = 0;
    shuttingDown = false;
    constructor(options) {
        this.options = options;
    }
    detachWorker(connection, options = {}) {
        const worker = connection.attachedWorker;
        if (worker) {
            worker.connections.delete(connection);
            connection.attachedWorker = undefined;
            worker.lastUsedAt = Date.now();
            this.maybeReleaseWorker(worker);
        }
        if (options.clearSelection) {
            connection.sessionFile = undefined;
            connection.sessionId = undefined;
        }
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
        worker.gracefulShutdownRequested = true;
        this.workers.delete(worker);
        this.deleteWorkerSessionRefs(worker);
        for (const connection of Array.from(worker.connections)) {
            if (connection.attachedWorker === worker) {
                connection.attachedWorker = undefined;
            }
            worker.connections.delete(connection);
            writeLine(connection.socket, {
                type: "worker_exit",
                code: null,
                signal: "SIGTERM",
            });
        }
        for (const pending of Array.from(worker.pendingResponses.values())) {
            if (pending.reject) {
                pending.reject(new Error("rin_worker_exit"));
                continue;
            }
            if (pending.connection) {
                writeLine(pending.connection.socket, responseError(pending.id, pending.commandType, "rin_worker_exit"));
            }
        }
        worker.pendingResponses.clear();
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
        const selector = this.getSessionSelector(command);
        if (selector.sessionFile || selector.sessionId) {
            this.rememberSessionSelection(connection, selector);
        }
        worker.lastUsedAt = Date.now();
        worker.releaseRequested = false;
        if (command?.id) {
            worker.pendingResponses.set(String(command.id), {
                id: String(command.id),
                commandType: String(command?.type || "unknown"),
                connection,
            });
        }
        worker.child.stdin.write(`${JSON.stringify(command)}\n`);
    }
    forwardToWorker(connection, worker, command) {
        this.requestWorker(worker, connection, command, true);
    }
    resolveWorkerForCommand(connection, command) {
        const type = String(command?.type || "unknown");
        const selector = this.resolveSelector(connection, command);
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
                if (connection.attachedWorker === worker) {
                    connection.attachedWorker = undefined;
                }
                worker.connections.delete(connection);
            }
            this.maybeReleaseWorker(worker);
        }
    }
    getRestorableSessionSelectors() {
        const seen = new Set();
        return Array.from(this.workers)
            .filter((worker) => worker.sessionFile &&
            !worker.gracefulShutdownRequested &&
            !seen.has(worker.sessionFile))
            .map((worker) => {
            const sessionFile = String(worker.sessionFile);
            seen.add(sessionFile);
            return {
                sessionFile,
                resumeTurn: Boolean(worker.isStreaming || worker.isCompacting),
            };
        });
    }
    restoreSessionWorker(item) {
        const sessionFile = String(item?.sessionFile || "").trim();
        if (!sessionFile)
            return;
        const worker = this.createWorker();
        this.setWorkerSessionRefs(worker, { sessionFile, sessionId: undefined });
        worker.child.stdin.write(`${JSON.stringify({ type: "switch_session", sessionPath: sessionFile })}\n`);
        if (item?.resumeTurn) {
            worker.child.stdin.write(`${JSON.stringify({ type: "resume_interrupted_turn", source: "daemon-restart" })}\n`);
        }
    }
    async shutdown(graceMs) {
        const restorable = this.getRestorableSessionSelectors();
        this.beginShutdown();
        const deadline = Date.now() + Math.max(0, graceMs);
        while (this.workers.size > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            for (const worker of Array.from(this.workers)) {
                this.maybeReleaseWorker(worker);
            }
        }
        this.destroyAll();
        return restorable;
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
                        if (!connection.socket.destroyed) {
                            connection.socket.write(`${line}\n`);
                        }
                    }
                    return;
                }
                this.updateWorkerMetadata(worker, payload);
                if (payload?.type === "response" &&
                    payload.id &&
                    worker.pendingResponses.has(String(payload.id))) {
                    const pending = worker.pendingResponses.get(String(payload.id));
                    worker.pendingResponses.delete(String(payload.id));
                    if (pending.connection && (worker.sessionFile || worker.sessionId)) {
                        this.rememberSessionSelection(pending.connection, {
                            sessionFile: worker.sessionFile,
                            sessionId: worker.sessionId,
                        });
                    }
                    if (pending.resolve)
                        pending.resolve(payload);
                    if (pending.connection)
                        writeLine(pending.connection.socket, payload);
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
            const liveConnections = new Set(worker.connections);
            for (const pending of worker.pendingResponses.values()) {
                if (pending.connection)
                    liveConnections.add(pending.connection);
            }
            const selector = {
                sessionFile: worker.sessionFile,
                sessionId: worker.sessionId,
            };
            const shouldRecover = this.shouldRecoverWorker(worker, liveConnections);
            this.deleteWorkerSessionRefs(worker);
            this.workers.delete(worker);
            for (const connection of Array.from(worker.connections)) {
                if (connection.attachedWorker === worker) {
                    connection.attachedWorker = undefined;
                }
            }
            worker.connections.clear();
            const pending = Array.from(worker.pendingResponses.values());
            worker.pendingResponses.clear();
            if (shouldRecover) {
                this.recoverWorker(selector, worker, liveConnections, pending);
                return;
            }
            for (const connection of liveConnections) {
                writeLine(connection.socket, {
                    type: "worker_exit",
                    code: code ?? null,
                    signal: signal ?? null,
                });
            }
            for (const entry of pending) {
                if (entry.reject) {
                    entry.reject(new Error("rin_worker_exit"));
                    continue;
                }
                if (entry.connection) {
                    writeLine(entry.connection.socket, responseError(entry.id, entry.commandType, "rin_worker_exit"));
                }
            }
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
        if (worker.sessionFile || worker.sessionId) {
            this.rememberSessionSelection(connection, {
                sessionFile: worker.sessionFile,
                sessionId: worker.sessionId,
            });
        }
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
    getConnectionSelector(connection) {
        return {
            sessionFile: typeof connection.sessionFile === "string" && connection.sessionFile
                ? connection.sessionFile
                : undefined,
            sessionId: typeof connection.sessionId === "string" && connection.sessionId
                ? connection.sessionId
                : undefined,
        };
    }
    resolveSelector(connection, command) {
        const commandSelector = this.getSessionSelector(command);
        const connectionSelector = this.getConnectionSelector(connection);
        return {
            sessionFile: commandSelector.sessionFile || connectionSelector.sessionFile,
            sessionId: commandSelector.sessionId || connectionSelector.sessionId,
        };
    }
    rememberSessionSelection(connection, selector) {
        if (selector.sessionFile !== undefined)
            connection.sessionFile = selector.sessionFile;
        if (selector.sessionId !== undefined)
            connection.sessionId = selector.sessionId;
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
        if (worker.sessionFile) {
            this.workersBySessionFile.set(worker.sessionFile, worker);
        }
        if (worker.sessionId)
            this.workersBySessionId.set(worker.sessionId, worker);
        for (const connection of worker.connections) {
            this.rememberSessionSelection(connection, next);
        }
    }
    shouldRecoverWorker(worker, liveConnections) {
        if (this.shuttingDown || worker.gracefulShutdownRequested)
            return false;
        return Boolean(worker.sessionFile && liveConnections.size > 0);
    }
    recoverWorker(selector, worker, liveConnections, pending) {
        const resumeTurn = Boolean(worker.isStreaming || worker.isCompacting);
        for (const connection of liveConnections) {
            this.rememberSessionSelection(connection, selector);
            writeLine(connection.socket, {
                type: "session_recovering",
                sessionFile: selector.sessionFile,
                sessionId: selector.sessionId,
                resumeTurn,
            });
        }
        for (const entry of pending) {
            if (entry.reject) {
                entry.reject(new Error("rin_session_recovering"));
                continue;
            }
            if (entry.connection) {
                writeLine(entry.connection.socket, responseError(entry.id, entry.commandType, "rin_session_recovering"));
            }
        }
        if (!selector.sessionFile)
            return;
        const replacement = this.createWorker();
        this.setWorkerSessionRefs(replacement, selector);
        for (const connection of liveConnections) {
            this.attachWorker(connection, replacement);
        }
        void (async () => {
            try {
                await this.sendInternalCommand(replacement, {
                    type: "switch_session",
                    sessionPath: selector.sessionFile,
                });
                if (resumeTurn) {
                    await this.sendInternalCommand(replacement, {
                        type: "resume_interrupted_turn",
                        source: "worker-exit",
                    });
                }
                for (const connection of liveConnections) {
                    writeLine(connection.socket, {
                        type: "session_recovered",
                        sessionFile: selector.sessionFile,
                        sessionId: selector.sessionId,
                        resumed: resumeTurn,
                    });
                }
            }
            catch {
                this.destroyWorker(replacement);
            }
        })().catch(() => { });
    }
    async sendInternalCommand(worker, command) {
        const id = `rin_internal_${++this.internalRequestSeq}`;
        return await new Promise((resolve, reject) => {
            worker.pendingResponses.set(id, {
                id,
                commandType: String(command?.type || "unknown"),
                resolve,
                reject,
            });
            try {
                worker.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
            }
            catch (error) {
                worker.pendingResponses.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
}
