#!/usr/bin/env node
/**
 * App daemon entrypoint.
 *
 * This is intentionally only an assembly wrapper:
 * it reuses the core daemon implementation and points it at the app worker.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startChatBridge } from "../../core/chat/main.js";
import { startDaemon } from "../../core/rin-daemon/daemon.js";
import { resolveRuntimeProfile } from "../../core/rin-lib/runtime.js";
import {
  cleanupOrphanSearxngSidecars,
  ensureSearxngSidecar,
  stopSearxngSidecar,
} from "../../core/rin-web-search/service.js";

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = path.extname(fileURLToPath(import.meta.url)) || ".js";
  const workerPath = path.join(here, `worker${ext}`);
  const runtime = resolveRuntimeProfile();
  const instanceId = `daemon-${process.pid}`;

  const ensureWebSearch = async () => {
    await cleanupOrphanSearxngSidecars(runtime.agentDir).catch(() => {});
    await ensureSearxngSidecar(runtime.agentDir, { instanceId }).catch(() => {});
  };
  void ensureWebSearch();

  const chatBridge = await startChatBridge({ hosted: true });

  const sidecarHealthTimer = setInterval(() => {
    void ensureWebSearch();
  }, 10_000);
  const stopServices = async () => {
    clearInterval(sidecarHealthTimer);
    await chatBridge.stop().catch(() => {});
    await stopSearxngSidecar(runtime.agentDir, { instanceId }).catch(() => {});
  };

  try {
    await startDaemon({
      workerPath,
      chat: {
        send: async (payload) => await chatBridge.send(payload),
        runTurn: async (payload) => await chatBridge.runTurn(payload),
      },
      getExtraStatus: () => ({
        chat: chatBridge.getStatus(),
      }),
      handleLocalCommand: async (command) => {
        const type = String(command?.type || "").trim();
        if (type !== "chat_bridge_eval") return undefined;
        return {
          success: true,
          data: await chatBridge.evalBridge(command?.payload || {}),
        };
      },
      onShutdown: stopServices,
    });
  } catch (error) {
    await stopServices().catch(() => {});
    throw error;
  }
}

main().catch((error: any) => {
  console.error(String(error?.message || error || "rin_app_daemon_failed"));
  process.exit(1);
});
