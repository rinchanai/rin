import path from "node:path";

import { resolveRuntimeProfile } from "../rin-lib/runtime.js";

export function resolveAgentDir(agentDirOverride = ""): string {
  const override = String(agentDirOverride || "").trim();
  return path.resolve(override || resolveRuntimeProfile().agentDir);
}
