import { createTargetExecutionContext, ParsedArgs } from "./shared.js";

export async function runDoctor(parsed: ParsedArgs) {
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

  lines.push(
    `webSearchRuntimeReady=${webSearchStatus?.runtime?.ready ? "yes" : "no"}`,
    `webSearchInstanceCount=${String(Array.isArray(webSearchStatus?.instances) ? webSearchStatus.instances.length : 0)}`,
  );
  for (const instance of Array.isArray(webSearchStatus?.instances)
    ? webSearchStatus.instances
    : []) {
    lines.push(
      `webSearchInstance=${instance.instanceId} pid=${String(instance.pid || 0)} alive=${instance.alive ? "yes" : "no"} port=${String(instance.port || "")} baseUrl=${instance.baseUrl || ""}`,
    );
  }

  lines.push(
    `chatBridgeReady=${chatStatus?.ready ? "yes" : "no"}`,
    `chatBridgeAdapterCount=${String(chatStatus?.adapterCount ?? 0)}`,
    `chatBridgeBotCount=${String(chatStatus?.botCount ?? 0)}`,
    `chatBridgeControllerCount=${String(chatStatus?.controllerCount ?? 0)}`,
    `chatBridgeDetachedControllerCount=${String(chatStatus?.detachedControllerCount ?? 0)}`,
  );

  if (daemonStatus) {
    lines.push(`daemonWorkerCount=${String(daemonStatus.workerCount ?? 0)}`);
    const workerLines = Array.isArray(daemonStatus.workers)
      ? daemonStatus.workers.map((worker: any) => {
          const sessionFile = worker.sessionFile
            ? String(worker.sessionFile)
            : "-";
          return `daemonWorker=${String(worker.id)} pid=${String(worker.pid)} role=${String(worker.role)} attached=${String(worker.attachedConnections)} pending=${String(worker.pendingResponses)} streaming=${String(worker.isStreaming)} compacting=${String(worker.isCompacting)} session=${sessionFile}`;
        })
      : [];
    lines.push(...workerLines);
  }

  if (context.systemctl) {
    for (const unit of [
      `rin-daemon-${context.targetUser}.service`,
      "rin-daemon.service",
    ]) {
      try {
        const status = context.capture([
          context.systemctl,
          "--user",
          "status",
          unit,
          "--no-pager",
          "-l",
        ]);
        lines.push(
          `serviceUnit=${unit}`,
          "serviceStatus:",
          ...String(status).trim().split(/\r?\n/).slice(0, 20),
        );
        break;
      } catch (error: any) {
        const text = String(
          error?.stdout || error?.stderr || error?.message || "",
        ).trim();
        if (text) {
          lines.push(
            `serviceUnit=${unit}`,
            "serviceStatus:",
            ...text.split(/\r?\n/).slice(0, 20),
          );
          break;
        }
      }
    }
    for (const unit of [
      `rin-daemon-${context.targetUser}.service`,
      "rin-daemon.service",
    ]) {
      try {
        const journal = context.capture([
          "journalctl",
          "--user",
          "-u",
          unit,
          "-n",
          "20",
          "--no-pager",
        ]);
        if (String(journal || "").trim()) {
          lines.push(
            `serviceJournal=${unit}`,
            ...String(journal).trim().split(/\r?\n/).slice(-20),
          );
          break;
        }
      } catch {}
    }
  }

  console.log(lines.join("\n"));
}
