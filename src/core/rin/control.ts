import { tryManagedSystemdAction } from "../rin-install/managed-service.js";
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
  const effectiveAction = action === "start" ? "restart" : action;
  const unit = tryManagedSystemdAction(context.managedServiceUnits, {
    daemonReload: () =>
      context.capture([context.systemctl, "--user", "daemon-reload"], {
        stdio: "ignore",
      }),
    probeUnit: (candidate) =>
      context.capture([context.systemctl, "--user", "status", candidate], {
        stdio: "ignore",
      }),
    runAction: (candidate) =>
      context.exec([context.systemctl, "--user", effectiveAction, candidate]),
  });
  if (!unit) return false;
  console.log(`rin ${action} complete: ${unit}`);
  return true;
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
