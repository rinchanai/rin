#!/usr/bin/env node
/**
 * App daemon entrypoint.
 *
 * This is intentionally only an assembly wrapper:
 * it reuses the core daemon implementation, but points it at the app worker,
 * so builtin extensions are force-loaded without teaching core about app policy.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

type AppSidecar = {
  instanceId: string;
  cleanup: () => Promise<unknown>;
  ensure: (instanceId: string) => Promise<unknown>;
  stop: (instanceId: string) => Promise<unknown>;
};

export function buildAppDaemonSidecars(
  agentDir: string,
  koishiEntryPath: string,
  deps: {
    cleanupOrphanSearxngSidecars?: typeof cleanupOrphanSearxngSidecars;
    ensureSearxngSidecar?: typeof ensureSearxngSidecar;
    stopSearxngSidecar?: typeof stopSearxngSidecar;
    cleanupOrphanKoishiSidecars?: typeof cleanupOrphanKoishiSidecars;
    ensureKoishiSidecar?: typeof ensureKoishiSidecar;
    stopKoishiSidecar?: typeof stopKoishiSidecar;
    pid?: number;
  } = {},
): AppSidecar[] {
  const pid = deps.pid ?? process.pid;
  const instanceId = `daemon-${pid}`;
  return [
    {
      instanceId,
      cleanup: () =>
        (deps.cleanupOrphanSearxngSidecars ?? cleanupOrphanSearxngSidecars)(
          agentDir,
        ),
      ensure: (currentInstanceId: string) =>
        (deps.ensureSearxngSidecar ?? ensureSearxngSidecar)(agentDir, {
          instanceId: currentInstanceId,
        }),
      stop: (currentInstanceId: string) =>
        (deps.stopSearxngSidecar ?? stopSearxngSidecar)(agentDir, {
          instanceId: currentInstanceId,
        }),
    },
    {
      instanceId,
      cleanup: () =>
        (deps.cleanupOrphanKoishiSidecars ?? cleanupOrphanKoishiSidecars)(
          agentDir,
        ),
      ensure: (currentInstanceId: string) =>
        (deps.ensureKoishiSidecar ?? ensureKoishiSidecar)(agentDir, {
          instanceId: currentInstanceId,
          entryPath: koishiEntryPath,
        }),
      stop: (currentInstanceId: string) =>
        (deps.stopKoishiSidecar ?? stopKoishiSidecar)(agentDir, {
          instanceId: currentInstanceId,
        }),
    },
  ];
}

export async function ensureAppDaemonSidecars(sidecars: AppSidecar[]) {
  for (const sidecar of sidecars) {
    await sidecar.cleanup().catch(() => {});
    await sidecar.ensure(sidecar.instanceId).catch(() => {});
  }
}

export async function main(
  deps: {
    importMetaUrl?: string;
    extname?: typeof path.extname;
    dirname?: typeof path.dirname;
    join?: typeof path.join;
    resolveRuntimeProfile?: typeof resolveRuntimeProfile;
    getBuiltinExtensionPaths?: typeof getBuiltinExtensionPaths;
    startDaemon?: typeof startDaemon;
    buildAppDaemonSidecars?: typeof buildAppDaemonSidecars;
    ensureAppDaemonSidecars?: typeof ensureAppDaemonSidecars;
    setInterval?: typeof globalThis.setInterval;
    clearInterval?: typeof globalThis.clearInterval;
    processOn?: typeof process.on;
  } = {},
) {
  const importMetaUrl = deps.importMetaUrl ?? import.meta.url;
  const extname = deps.extname ?? path.extname;
  const dirname = deps.dirname ?? path.dirname;
  const join = deps.join ?? path.join;
  const resolveRuntime = deps.resolveRuntimeProfile ?? resolveRuntimeProfile;
  const startDaemonFn = deps.startDaemon ?? startDaemon;
  const buildSidecars = deps.buildAppDaemonSidecars ?? buildAppDaemonSidecars;
  const ensureSidecarsNow =
    deps.ensureAppDaemonSidecars ?? ensureAppDaemonSidecars;
  const setIntervalFn = deps.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval;
  const processOn = deps.processOn ?? process.on.bind(process);

  const resolvedImportPath = fileURLToPath(importMetaUrl);
  const here = dirname(resolvedImportPath);
  const ext = extname(resolvedImportPath) || ".js";
  const workerPath = join(here, `worker${ext}`);
  const koishiEntryPath = join(here, "..", "rin-koishi", `main${ext}`);
  const runtime = resolveRuntime();
  const sidecars = buildSidecars(runtime.agentDir, koishiEntryPath);

  await ensureSidecarsNow(sidecars);
  const sidecarHealthTimer = setIntervalFn(() => {
    void ensureSidecarsNow(sidecars);
  }, 10_000);
  const stop = () => {
    clearIntervalFn(sidecarHealthTimer);
    for (const sidecar of sidecars) {
      void sidecar.stop(sidecar.instanceId).catch(() => {});
    }
  };
  processOn("SIGINT", stop);
  processOn("SIGTERM", stop);
  processOn("exit", stop);
  await startDaemonFn({
    workerPath,
    additionalExtensionPaths: (
      deps.getBuiltinExtensionPaths ?? getBuiltinExtensionPaths
    )(),
  });
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    console.error(String(error?.message || error || "rin_app_daemon_failed"));
    process.exit(1);
  });
}
