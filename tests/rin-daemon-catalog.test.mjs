import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const catalogModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "catalog.js"))
    .href
);

const { listCatalogCommands, listCatalogModels, getCatalogOAuthState } =
  catalogModule;
const { getBuiltinExtensionPaths } = await import(
  pathToFileURL(path.join(rootDir, "dist", "app", "builtin-extensions.js")).href
);

async function createTestAgentDir() {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  await fs.writeFile(
    path.join(agentDir, "auth.json"),
    JSON.stringify({
      "google-gemini-cli": { type: "api_key", key: "test-key" },
    }),
  );
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({}));
  return agentDir;
}

test("daemon catalog lists builtin and extension commands without session worker", async () => {
  const agentDir = await createTestAgentDir();
  const commands = await listCatalogCommands({
    cwd: rootDir,
    agentDir,
    additionalExtensionPaths: getBuiltinExtensionPaths(),
  });
  const names = new Set(commands.map((item) => item.name));
  assert.equal(names.has("settings"), true);
  assert.equal(names.has("model"), true);
  assert.equal(names.has("init"), true);
});

test("daemon catalog lists available models directly", async () => {
  const agentDir = await createTestAgentDir();
  const models = await listCatalogModels({
    cwd: rootDir,
    agentDir,
  });
  assert.equal(Array.isArray(models), true);
  assert.equal(models.length > 0, true);
});

test("daemon catalog reads oauth state directly", async () => {
  const agentDir = await createTestAgentDir();
  const state = await getCatalogOAuthState({
    cwd: rootDir,
    agentDir,
  });
  assert.equal(Array.isArray(state.providers), true);
  assert.equal(typeof state.credentials, "object");
});
