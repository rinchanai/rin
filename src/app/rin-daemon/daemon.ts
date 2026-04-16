#!/usr/bin/env node
/**
 * App daemon entrypoint.
 *
 * This is intentionally only an assembly wrapper:
 * it reuses the core daemon implementation and points it at the app worker.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon } from "../../core/rin-daemon/daemon.js";
import {
  cleanupOrphanChatSidecars,
  ensureChatSidecar,
  stopChatSidecar,
} from "../../core/chat/service.js";
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
  const chatEntryPath = path.join(here, "..", "rin-chat", `main${ext}`);
  const runtime = resolveRuntimeProfile();
  const sidecars = [
    {
      instanceId: `daemon-${process.pid}`,
      cleanup: () => cleanupOrphanSearxngSidecars(runtime.agentDir),
      ensure: (instanceId: string) =>
        ensureSearxngSidecar(runtime.agentDir, { instanceId }),
      stop: (instanceId: string) =>
        stopSearxngSidecar(runtime.agentDir, { instanceId }),
    },
    {
      instanceId: `daemon-${process.pid}`,
      cleanup: () => cleanupOrphanChatSidecars(runtime.agentDir),
      ensure: (instanceId: string) =>
        ensureChatSidecar(runtime.agentDir, {
          instanceId,
          entryPath: chatEntryPath,
        }),
      stop: (instanceId: string) =>
        stopChatSidecar(runtime.agentDir, { instanceId }),
    },
  ];

  const ensureSidecars = async () => {
    for (const sidecar of sidecars) {
      await sidecar.cleanup().catch(() => {});
      await sidecar.ensure(sidecar.instanceId).catch(() => {});
    }
  };

  await ensureSidecars();
  const sidecarHealthTimer = setInterval(() => {
    void ensureSidecars();
  }, 10_000);
  const stop = () => {
    clearInterval(sidecarHealthTimer);
    for (const sidecar of sidecars) {
      void sidecar.stop(sidecar.instanceId).catch(() => {});
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", stop);
  await startDaemon({
    workerPath,
  });
}

main().catch((error: any) => {
  console.error(String(error?.message || error || "rin_app_daemon_failed"));
  process.exit(1);
});
