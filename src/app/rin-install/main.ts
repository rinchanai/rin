#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { startInstaller } from "../../core/rin-install/main.js";

export async function main(
  deps: {
    startInstaller?: typeof startInstaller;
  } = {},
) {
  await (deps.startInstaller ?? startInstaller)();
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    console.error(String(error?.message || error || "rin_app_install_failed"));
    process.exit(1);
  });
}
