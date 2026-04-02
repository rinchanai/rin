import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * App-level builtin extension manifest.
 *
 * These extensions are standard pi extensions under /extensions,
 * but the app build force-loads them so users do not have to configure
 * or install them manually.
 */
function repoRootFromHere() {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let current = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir, "..", "..");
}

export function getBuiltinExtensionPaths() {
  const root = repoRootFromHere();
  return [
    path.join(
      root,
      "dist",
      "extensions",
      "discover-attention-resources",
      "index.js",
    ),
    path.join(root, "dist", "extensions", "web-search", "index.js"),
    path.join(root, "dist", "extensions", "fetch", "index.js"),
    path.join(root, "dist", "extensions", "memory", "index.js"),
    path.join(root, "dist", "extensions", "reset-system-prompt", "index.js"),
    path.join(root, "dist", "extensions", "message-header", "index.js"),
    path.join(root, "dist", "extensions", "rin-project-docs", "index.js"),
    path.join(root, "dist", "extensions", "freeze-session-runtime", "index.js"),
    path.join(root, "dist", "extensions", "tui-input-compat", "index.js"),
    path.join(root, "dist", "extensions", "subagent", "index.js"),
    path.join(root, "dist", "extensions", "cron", "index.js"),
    path.join(root, "dist", "extensions", "koishi-send-message", "index.js"),
    path.join(root, "dist", "extensions", "koishi-get-message", "index.js"),
  ];
}
