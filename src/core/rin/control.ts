import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  ParsedArgs,
  requireTool,
} from "./shared.js";

function tryManagedServiceAction(
  context: ReturnType<typeof createTargetExecutionContext>,
  action: "start" | "stop" | "restart",
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
      console.log(`rin ${action} complete: ${unit}`);
      return true;
    } catch {}
  }
  return false;
}

export async function runStart(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  if (tryManagedServiceAction(context, "start")) return;
  await ensureDaemonAvailable(context);
  console.log("rin start complete");
}

export async function runStop(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  if (tryManagedServiceAction(context, "stop")) return;
  try {
    const pkill = requireTool("pkill", ["/usr/bin/pkill", "/bin/pkill"]);
    const daemonPattern = `${context.installDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/app/.*/dist/(app/rin-daemon/daemon\\.js|daemon\\.js)`;
    context.capture([pkill, "-f", daemonPattern], { stdio: "ignore" });
  } catch {}
  console.log("rin stop complete");
}

export async function runRestart(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  if (tryManagedServiceAction(context, "restart")) return;
  await runStop(parsed);
  await runStart(parsed);
  console.log("rin restart complete");
}
