import { loadRinInteractiveModeModule } from "../rin-lib/loader.js";
import {
  applyRuntimeProfileEnvironment,
  createConfiguredAgentSession,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import {
  ensureSearxngSidecar,
  stopSearxngSidecar,
} from "../rin-web-search/service.js";

import { RinDaemonFrontendClient } from "./rpc-client.js";
import { RpcInteractiveSession } from "./runtime.js";
import { createRpcRuntimeHost } from "./runtime-host.js";
import { applyRinTuiOverrides } from "./upstream-overrides.js";

type TuiMode = "rpc" | "std";

function startupProfiler() {
  const enabled = /^(1|true|yes)$/i.test(
    String(process.env.RIN_STARTUP_PROFILE || "").trim(),
  );
  const startedAt = Date.now();
  let lastAt = startedAt;
  return {
    mark(label: string) {
      if (!enabled) return;
      const now = Date.now();
      const delta = now - lastAt;
      const total = now - startedAt;
      lastAt = now;
      console.error(`[rin-startup] ${label} +${delta}ms total=${total}ms`);
    },
  };
}

function parseMode(argv: string[]): TuiMode {
  const envMode = String(process.env.RIN_TUI_MODE || "")
    .trim()
    .toLowerCase();
  if (envMode === "std") return "std";
  if (envMode === "rpc") return "rpc";
  if (argv.includes("--std")) return "std";
  if (argv.includes("--rpc")) return "rpc";
  return "rpc";
}

export async function startTui(
  options: { additionalExtensionPaths?: string[] } = {},
) {
  const profile = startupProfiler();
  const runtime = resolveRuntimeProfile();
  profile.mark("runtime-resolved");
  applyRuntimeProfileEnvironment(runtime);
  if (process.cwd() !== runtime.cwd) {
    process.chdir(runtime.cwd);
  }

  const mode = parseMode(process.argv.slice(2));
  profile.mark(`mode=${mode}`);

  const client = mode === "rpc" ? new RinDaemonFrontendClient() : null;
  const rpcSession =
    mode === "rpc"
      ? new RpcInteractiveSession(client!, options.additionalExtensionPaths)
      : null;
  const interactiveModeModulePromise = loadRinInteractiveModeModule();
  const overridesPromise = applyRinTuiOverrides();
  const rpcReadyPromise = rpcSession ? rpcSession.connect() : Promise.resolve();

  const [{ InteractiveMode }] = await Promise.all([
    interactiveModeModulePromise as Promise<any>,
    overridesPromise,
    rpcReadyPromise,
  ]);
  profile.mark("interactive-mode-and-rpc-ready");

  if (mode === "std") {
    const webSearchInstanceId = `tui-${process.pid}`;
    await ensureSearxngSidecar(runtime.agentDir, {
      instanceId: webSearchInstanceId,
    }).catch(() => {});
    const { runtime: sessionRuntime } = await createConfiguredAgentSession({
      additionalExtensionPaths: options.additionalExtensionPaths,
    });
    profile.mark("std-session-created");
    const interactiveMode = new InteractiveMode(sessionRuntime);
    try {
      await interactiveMode.run();
    } finally {
      await stopSearxngSidecar(runtime.agentDir, {
        instanceId: webSearchInstanceId,
      }).catch(() => {});
    }
    return;
  }

  profile.mark("rpc-session-created");

  const runtimeHost = createRpcRuntimeHost(rpcSession!);
  try {
    const interactiveMode = new InteractiveMode(runtimeHost as any);
    await interactiveMode.run();
  } finally {
    await runtimeHost.dispose().catch(() => {});
  }
}
