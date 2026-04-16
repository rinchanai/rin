#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { createConfiguredAgentSession } from "../rin-lib/runtime.js";
import { runCustomRpcMode } from "./rpc-mode.js";

export async function startWorker(
  options: { additionalExtensionPaths?: string[] } = {},
) {
  const sessionManagerModule = await loadRinSessionManagerModule();
  const { runtime } = await createConfiguredAgentSession({
    additionalExtensionPaths: options.additionalExtensionPaths,
  });
  await runCustomRpcMode(runtime, {
    SessionManager: sessionManagerModule.SessionManager,
    reuseFreshSessionForInitialNewSession: true,
  });
}

async function main() {
  await startWorker();
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    const message = String(
      error && error.message ? error.message : error || "rin_worker_failed",
    );
    console.error(message);
    process.exit(1);
  });
}
