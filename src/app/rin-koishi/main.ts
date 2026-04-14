#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { startKoishi } from "../../core/rin-koishi/main.js";
import { getBuiltinExtensionPaths } from "../builtin-extensions.js";

export async function main(
  deps: {
    startKoishi?: typeof startKoishi;
    getBuiltinExtensionPaths?: typeof getBuiltinExtensionPaths;
  } = {},
) {
  await (deps.startKoishi ?? startKoishi)({
    additionalExtensionPaths: (
      deps.getBuiltinExtensionPaths ?? getBuiltinExtensionPaths
    )(),
  });
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    console.error(String(error?.message || error || "rin_app_koishi_failed"));
    process.exit(1);
  });
}
