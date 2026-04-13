import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  ParsedArgs,
  requireTool,
} from "./shared.js";

type ControlDeps = {
  createTargetExecutionContext?: typeof createTargetExecutionContext;
  ensureDaemonAvailable?: typeof ensureDaemonAvailable;
  requireTool?: typeof requireTool;
  log?: (text: string) => void;
};

function tryManagedServiceAction(
  context: ReturnType<typeof createTargetExecutionContext>,
  action: "start" | "stop" | "restart",
  log: (text: string) => void,
) {
  if (!context.systemctl) return false;
  try {
    context.capture([context.systemctl, "--user", "daemon-reload"], {
      stdio: "ignore",
    });
  } catch {}
  for (const unit of [
    `rin-daemon-${context.targetUser}.service`,
    "rin-daemon.service",
  ]) {
    try {
      context.capture([context.systemctl, "--user", "status", unit], {
        stdio: "ignore",
      });
      const effectiveAction = action === "start" ? "restart" : action;
      context.exec([context.systemctl, "--user", effectiveAction, unit]);
      log(`rin ${action} complete: ${unit}`);
      return true;
    } catch {}
  }
  return false;
}

export async function runStart(parsed: ParsedArgs, deps: ControlDeps = {}) {
  const context = (
    deps.createTargetExecutionContext ?? createTargetExecutionContext
  )(parsed);
  const ensureDaemon = deps.ensureDaemonAvailable ?? ensureDaemonAvailable;
  const log = deps.log ?? ((text: string) => console.log(text));
  if (tryManagedServiceAction(context, "start", log)) return;
  await ensureDaemon(context);
  log("rin start complete");
}

export async function runStop(parsed: ParsedArgs, deps: ControlDeps = {}) {
  const context = (
    deps.createTargetExecutionContext ?? createTargetExecutionContext
  )(parsed);
  const resolveTool = deps.requireTool ?? requireTool;
  const log = deps.log ?? ((text: string) => console.log(text));
  if (tryManagedServiceAction(context, "stop", log)) return;
  try {
    const pkill = resolveTool("pkill", ["/usr/bin/pkill", "/bin/pkill"]);
    const daemonPattern = `${context.installDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/app/.*/dist/(app/rin-daemon/daemon\\.js|daemon\\.js)`;
    context.capture([pkill, "-f", daemonPattern], { stdio: "ignore" });
  } catch {}
  log("rin stop complete");
}

export async function runRestart(parsed: ParsedArgs, deps: ControlDeps = {}) {
  const context = (
    deps.createTargetExecutionContext ?? createTargetExecutionContext
  )(parsed);
  const log = deps.log ?? ((text: string) => console.log(text));
  if (tryManagedServiceAction(context, "restart", log)) return;
  await runStop(parsed, deps);
  await runStart(parsed, deps);
  log("rin restart complete");
}
