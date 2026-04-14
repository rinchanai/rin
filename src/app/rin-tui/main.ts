#!/usr/bin/env node
/**
 * App TUI entrypoint.
 *
 * Thin assembly wrapper over the shared core TUI launcher.
 * The only app-specific behavior here is force-loading builtin extensions.
 */
import { pathToFileURL } from "node:url";

import { startTui } from "../../core/rin-tui/launcher.js";
import { getBuiltinExtensionPaths } from "../builtin-extensions.js";

export async function main(
  deps: {
    startTui?: typeof startTui;
    getBuiltinExtensionPaths?: typeof getBuiltinExtensionPaths;
  } = {},
) {
  await (deps.startTui ?? startTui)({
    additionalExtensionPaths: (
      deps.getBuiltinExtensionPaths ?? getBuiltinExtensionPaths
    )(),
  });
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    console.error(String(error?.message || error || "rin_app_tui_failed"));
    process.exit(1);
  });
}
