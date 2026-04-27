import {
  InteractiveMode,
  type InteractiveModeOptions,
} from "@mariozechner/pi-coding-agent";

import {
  applyRuntimeProfileEnvironment,
  createConfiguredAgentSession,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";

import { RinDaemonFrontendClient } from "./rpc-client.js";
import { RpcInteractiveSession } from "./runtime.js";
import { createRpcRuntimeHost } from "./runtime-host.js";
import { applyRinTuiOverrides } from "./upstream-overrides.js";

const VALID_TUI_MODES = ["rpc", "std"] as const;

type TuiMode = (typeof VALID_TUI_MODES)[number];
type TuiInteractiveOptions = Pick<
  InteractiveModeOptions,
  "initialMessage" | "initialMessages" | "verbose"
>;
const RPC_TUI_STARTUP_CONNECT_ERROR_RE =
  /\bconnect (?:ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)\b/;

export function formatTuiStartupError(error: unknown) {
  const message = String((error as any)?.message || error || "").trim();
  if (!message) return "rin_tui_failed";
  if (!RPC_TUI_STARTUP_CONNECT_ERROR_RE.test(message)) return message;
  return `RPC TUI could not connect to the daemon (${message}). Try \`rin doctor\` to inspect the daemon, or reopen Rin with \`rin --std\`.`;
}

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

export function normalizeTuiMode(value: unknown): TuiMode | undefined {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_TUI_MODES.includes(mode as TuiMode)
    ? (mode as TuiMode)
    : undefined;
}

function tuiModeFlag(mode: TuiMode): "--rpc" | "--std" {
  return mode === "std" ? "--std" : "--rpc";
}

function resolveArgvTuiMode(argv: string[]): TuiMode | undefined {
  const wantsStd = argv.includes("--std");
  const wantsRpc = argv.includes("--rpc");
  if (wantsStd && wantsRpc) {
    throw new Error("Conflicting TUI mode flags: --std, --rpc.");
  }
  if (wantsStd) return "std";
  if (wantsRpc) return "rpc";
  return undefined;
}

export function resolveTuiMode(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): TuiMode {
  const envValue = String(env.RIN_TUI_MODE || "").trim();
  const envMode = normalizeTuiMode(envValue);
  if (envValue && !envMode) {
    throw new Error(
      `Invalid RIN_TUI_MODE: ${envValue}. Allowed values: ${VALID_TUI_MODES.join(", ")}.`,
    );
  }

  const argvMode = resolveArgvTuiMode(argv);
  if (envMode && argvMode && envMode !== argvMode) {
    throw new Error(
      `Conflicting TUI mode requests: RIN_TUI_MODE=${envMode} and ${tuiModeFlag(argvMode)}.`,
    );
  }

  return envMode || argvMode || "rpc";
}

export function resolveTuiInteractiveOptions(
  argv: string[],
): TuiInteractiveOptions {
  const messages: string[] = [];
  let passThroughMessages = false;
  for (const rawArg of argv) {
    const arg = String(rawArg || "").trim();
    if (!arg) continue;
    if (passThroughMessages) {
      messages.push(arg);
      continue;
    }
    if (arg === "--") {
      passThroughMessages = true;
      continue;
    }
    if (arg === "--rpc" || arg === "--std" || arg === "--verbose") {
      continue;
    }
    if (arg.startsWith("-")) continue;
    messages.push(arg);
  }

  return {
    initialMessage: messages[0],
    initialMessages: messages.length > 1 ? messages.slice(1) : undefined,
    verbose: argv.includes("--verbose") || undefined,
  };
}

export function shouldPrintStartupSeparator(
  sessionLike: any,
  options: TuiInteractiveOptions = {},
) {
  if (options.verbose) return true;
  const getQuietStartup = sessionLike?.settingsManager?.getQuietStartup;
  if (typeof getQuietStartup !== "function") return true;
  return !Boolean(getQuietStartup.call(sessionLike.settingsManager));
}

async function runInteractiveMode(
  runtime: ConstructorParameters<typeof InteractiveMode>[0],
  interactiveOptions: TuiInteractiveOptions,
) {
  const interactiveMode = new InteractiveMode(runtime, interactiveOptions);
  try {
    await interactiveMode.run();
  } catch (error) {
    interactiveMode.stop?.();
    throw error;
  }
}

async function startStdTui(
  options: { additionalExtensionPaths?: string[] },
  profile: ReturnType<typeof startupProfiler>,
  interactiveOptions: TuiInteractiveOptions,
) {
  const { runtime: sessionRuntime } = await createConfiguredAgentSession({
    additionalExtensionPaths: options.additionalExtensionPaths,
  });
  profile.mark("std-session-created");
  if (shouldPrintStartupSeparator(sessionRuntime.session, interactiveOptions)) {
    console.log();
  }
  await runInteractiveMode(sessionRuntime, interactiveOptions);
}

async function startRpcTui(
  options: { additionalExtensionPaths?: string[] },
  profile: ReturnType<typeof startupProfiler>,
  interactiveOptions: TuiInteractiveOptions,
) {
  const client = new RinDaemonFrontendClient();
  const rpcSession = new RpcInteractiveSession(
    client,
    options.additionalExtensionPaths,
  );
  try {
    await rpcSession.connect();
    await rpcSession.ensureSessionReady();
  } catch (error) {
    throw new Error(formatTuiStartupError(error), { cause: error });
  }
  profile.mark("interactive-mode-and-rpc-ready");

  let runtimeHost: { dispose(): Promise<void> } | undefined;
  try {
    runtimeHost = createRpcRuntimeHost(rpcSession);
    profile.mark("rpc-session-created");
    if (shouldPrintStartupSeparator(rpcSession, interactiveOptions)) {
      console.log();
    }
    await runInteractiveMode(runtimeHost as any, interactiveOptions);
  } finally {
    if (runtimeHost) {
      await runtimeHost.dispose().catch(() => {});
    } else {
      await rpcSession.disconnect().catch(() => {});
    }
  }
}

export async function startTui(
  options: { additionalExtensionPaths?: string[]; argv?: string[] } = {},
) {
  const profile = startupProfiler();
  const runtime = resolveRuntimeProfile();
  profile.mark("runtime-resolved");
  applyRuntimeProfileEnvironment(runtime);
  if (process.cwd() !== runtime.cwd) {
    process.chdir(runtime.cwd);
  }

  const argv = options.argv ?? process.argv.slice(2);
  const mode = resolveTuiMode(argv);
  const interactiveOptions = resolveTuiInteractiveOptions(argv);
  profile.mark(`mode=${mode}`);

  await applyRinTuiOverrides();

  if (mode === "std") {
    await startStdTui(options, profile, interactiveOptions);
    return;
  }

  await startRpcTui(options, profile, interactiveOptions);
}
