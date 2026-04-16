#!/usr/bin/env node
/**
 * App worker entrypoint.
 *
 * This file exists so app can point the shared core worker at the product shell.
 */
import { startWorker } from "../../core/rin-daemon/worker.js";

async function main() {
  await startWorker();
}

main().catch((error: any) => {
  console.error(String(error?.message || error || "rin_app_worker_failed"));
  process.exit(1);
});
