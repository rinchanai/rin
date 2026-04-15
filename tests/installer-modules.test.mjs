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
const provider = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "provider-auth.js"),
  ).href
);
const persist = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "persist.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-installer-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("provider-auth computes available thinking levels deterministically", () => {
  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: "openai",
      id: "codex-max",
      reasoning: true,
    }),
    ["off", "minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: "anthropic",
      id: "claude",
      reasoning: true,
    }),
    ["off", "minimal", "low", "medium", "high"],
  );
  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: "x",
      id: "y",
      reasoning: false,
    }),
    ["off"],
  );
});

test("persist reconcileInstallerManifest writes manifest with expected fields", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const result = persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        chatConfig: { telegram: { token: "x" } },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );
    assert.ok(result.manifestPath.endsWith(path.join(dir, "installer.json")));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].value.defaultProvider, "openai");
    assert.equal(writes[0].value.defaultModel, "gpt");
    assert.equal(writes[0].value.defaultThinkingLevel, "medium");
  });
});

test("persist normalizeInstalledChatSettings migrates legacy koishi settings", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    persist.normalizeInstalledChatSettings(
      {
        targetUser: "demo",
        installDir: dir,
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        readInstallerJson: () => ({ koishi: { telegram: { token: "x" } } }),
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
      },
    );
    assert.equal(writes.length, 1);
    assert.ok(writes[0].filePath.endsWith(path.join(dir, "settings.json")));
    assert.deepEqual(writes[0].value.chat, { telegram: { token: "x" } });
    assert.equal("koishi" in writes[0].value, false);
  });
});
