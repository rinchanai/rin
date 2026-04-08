import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolveRepoRoot() {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let current = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(current, "third_party", "pi-coding-agent");
    if (fs.existsSync(path.join(candidate, "dist", "index.js"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir, "..", "..", "..");
}

const repoRoot = resolveRepoRoot();
const codingAgentRoot = path.join(repoRoot, "third_party", "pi-coding-agent");
const codingAgentDistRoot = path.join(codingAgentRoot, "dist");

function requireDistModule(relativePath: string) {
  const filePath = path.join(codingAgentDistRoot, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`rin_missing_vendor_dist:${relativePath}`);
  }
  return filePath;
}

async function importDistModule(relativePath: string) {
  return await import(pathToFileURL(requireDistModule(relativePath)).href);
}

export async function loadRinCodingAgent() {
  return await importDistModule("index.js");
}

export async function loadRinSessionManagerModule() {
  return await importDistModule(path.join("core", "session-manager.js"));
}

export async function loadRinInteractiveModeModule() {
  return await importDistModule(
    path.join("modes", "interactive", "interactive-mode.js"),
  );
}

export async function loadRinInteractiveFooterModule() {
  return await importDistModule(
    path.join("modes", "interactive", "components", "footer.js"),
  );
}

export async function loadRinInteractiveThemeModule() {
  return await importDistModule(
    path.join("modes", "interactive", "theme", "theme.js"),
  );
}

export async function loadRinSessionSelectorModule() {
  return await importDistModule(
    path.join("modes", "interactive", "components", "session-selector.js"),
  );
}

export function resolveRinCodingAgentDistDir() {
  return codingAgentDistRoot;
}
