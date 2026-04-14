#!/usr/bin/env node
/**
 * App worker entrypoint.
 *
 * This file exists so app can inject builtin extension paths while keeping
 * the core worker independently runnable and free of app-specific profiles.
 */
import { pathToFileURL } from "node:url";

import { startWorker } from "../../core/rin-daemon/worker.js";
import { getBuiltinExtensionPaths } from "../builtin-extensions.js";

export async function main(
  deps: {
    startWorker?: typeof startWorker;
    getBuiltinExtensionPaths?: typeof getBuiltinExtensionPaths;
  } = {},
) {
  await (deps.startWorker ?? startWorker)({
    additionalExtensionPaths: (
      deps.getBuiltinExtensionPaths ?? getBuiltinExtensionPaths
    )(),
  });
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    console.error(String(error?.message || error || "rin_app_worker_failed"));
    process.exit(1);
  });
}
