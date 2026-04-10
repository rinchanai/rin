#!/usr/bin/env node
/**
 * App daemon entrypoint.
 *
 * This is intentionally only an assembly wrapper:
 * it reuses the core daemon implementation, but points it at the app worker,
 * so builtin extensions are force-loaded without teaching core about app policy.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getBuiltinExtensionPaths } from "../builtin-extensions.js";
import { startDaemon } from "../../core/rin-daemon/daemon.js";
import {
  cleanupOrphanKoishiSidecars,
  ensureKoishiSidecar,
  stopKoishiSidecar,
} from "../../core/rin-koishi/service.js";
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
  const koishiEntryPath = path.join(here, "..", "rin-koishi", `main${ext}`);
  const runtime = resolveRuntimeProfile();
  const webSearchInstanceId = `daemon-${process.pid}`;
  const koishiInstanceId = `daemon-${process.pid}`;
  const ensureSidecars = async () => {
    await cleanupOrphanSearxngSidecars(runtime.agentDir).catch(() => {});
    await cleanupOrphanKoishiSidecars(runtime.agentDir).catch(() => {});
    await ensureSearxngSidecar(runtime.agentDir, {
      instanceId: webSearchInstanceId,
    }).catch(() => {});
    await ensureKoishiSidecar(runtime.agentDir, {
      instanceId: koishiInstanceId,
      entryPath: koishiEntryPath,
    }).catch(() => {});
  };

  await ensureSidecars();
  const sidecarHealthTimer = setInterval(() => {
    void ensureSidecars();
  }, 10_000);
  const stop = () => {
    clearInterval(sidecarHealthTimer);
    void stopSearxngSidecar(runtime.agentDir, {
      instanceId: webSearchInstanceId,
    }).catch(() => {});
    void stopKoishiSidecar(runtime.agentDir, {
      instanceId: koishiInstanceId,
    }).catch(() => {});
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", stop);
  await startDaemon({
    workerPath,
    additionalExtensionPaths: getBuiltinExtensionPaths(),
  });
}

main().catch((error: any) => {
  console.error(String(error?.message || error || "rin_app_daemon_failed"));
  process.exit(1);
});
