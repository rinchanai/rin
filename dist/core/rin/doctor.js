import { findManagedSystemdJournalSnapshot, findManagedSystemdStatusSnapshot, } from "../rin-install/managed-service.js";
import { createTargetExecutionContext } from "./shared.js";
export async function runDoctor(parsed) {
    const context = createTargetExecutionContext(parsed);
    const socketReady = await context.canConnectSocket();
    const daemonStatus = socketReady
        ? await context.queryDaemonStatus()
        : undefined;
    const webSearchStatus = daemonStatus?.webSearch;
    const chatStatus = daemonStatus?.chat;
    const lines = [
        `targetUser=${context.targetUser}`,
        `installDir=${context.installDir}`,
        `socketPath=${context.socketPath}`,
        `socketReady=${socketReady ? "yes" : "no"}`,
        `serviceManager=${context.systemctl ? "systemd-user" : "none"}`,
    ];
    lines.push(`webSearchRuntimeReady=${webSearchStatus?.runtime?.ready ? "yes" : "no"}`, `webSearchInstanceCount=${String(Array.isArray(webSearchStatus?.instances) ? webSearchStatus.instances.length : 0)}`);
    for (const instance of Array.isArray(webSearchStatus?.instances)
        ? webSearchStatus.instances
        : []) {
        lines.push(`webSearchInstance=${instance.instanceId} pid=${String(instance.pid || 0)} alive=${instance.alive ? "yes" : "no"} port=${String(instance.port || "")} baseUrl=${instance.baseUrl || ""}`);
    }
    lines.push(`chatBridgeReady=${chatStatus?.ready ? "yes" : "no"}`, `chatBridgeAdapterCount=${String(chatStatus?.adapterCount ?? 0)}`, `chatBridgeBotCount=${String(chatStatus?.botCount ?? 0)}`, `chatBridgeControllerCount=${String(chatStatus?.controllerCount ?? 0)}`, `chatBridgeDetachedControllerCount=${String(chatStatus?.detachedControllerCount ?? 0)}`);
    if (daemonStatus) {
        lines.push(`daemonWorkerCount=${String(daemonStatus.workerCount ?? 0)}`);
        const workerLines = Array.isArray(daemonStatus.workers)
            ? daemonStatus.workers.map((worker) => {
                const sessionFile = worker.sessionFile
                    ? String(worker.sessionFile)
                    : "-";
                return `daemonWorker=${String(worker.id)} pid=${String(worker.pid)} role=${String(worker.role)} attached=${String(worker.attachedConnections)} pending=${String(worker.pendingResponses)} streaming=${String(worker.isStreaming)} compacting=${String(worker.isCompacting)} session=${sessionFile}`;
            })
            : [];
        lines.push(...workerLines);
    }
    if (context.systemctl) {
        const status = findManagedSystemdStatusSnapshot(context.managedServiceUnits, (unit) => context.capture([
            context.systemctl,
            "--user",
            "status",
            unit,
            "--no-pager",
            "-l",
        ]));
        if (status) {
            lines.push(`serviceUnit=${status.unit}`, "serviceStatus:", ...status.lines);
        }
        const journal = findManagedSystemdJournalSnapshot(context.managedServiceUnits, (unit) => context.capture([
            "journalctl",
            "--user",
            "-u",
            unit,
            "-n",
            "20",
            "--no-pager",
        ]));
        if (journal) {
            lines.push(`serviceJournal=${journal.unit}`, ...journal.lines);
        }
    }
    console.log(lines.join("\n"));
}
