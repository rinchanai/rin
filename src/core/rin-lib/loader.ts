import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
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

export function resolveRinCodingAgentDistDir() {
  return codingAgentDistRoot;
}
