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
const installRecord = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "install-record.js"),
  ).href
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

test("install-record normalizes launcher metadata and installer manifests", () => {
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    }),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      targetUser: "manifest-demo",
    }),
    {
      defaultTargetUser: "manifest-demo",
      defaultInstallDir: "/home/demo/.rin",
    },
  );
  assert.deepEqual(
    installRecord.resolveInstallRecordTarget("/home/demo", "fallback-user", {
      defaultInstallDir: "/srv/rin-demo",
    }),
    {
      targetUser: "fallback-user",
      installDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.loadInstallRecordFromCandidates(
      "/home/demo",
      ["missing", "manifest"],
      (filePath) =>
        filePath === "manifest" ? { targetUser: "candidate-demo" } : null,
    ),
    {
      defaultTargetUser: "candidate-demo",
      defaultInstallDir: "/home/demo/.rin",
    },
  );
  assert.deepEqual(
    installRecord.resolveInstallRecordTargetFromCandidates(
      "/home/demo",
      "fallback-user",
      ["missing", "launcher"],
      (filePath) =>
        filePath === "launcher"
          ? { defaultInstallDir: "/srv/rin-demo" }
          : null,
    ),
    {
      targetUser: "fallback-user",
      installDir: "/srv/rin-demo",
    },
  );
  assert.equal(installRecord.normalizeInstallRecord("/home/demo", null), null);
});

test("persist reconcileInstallerManifest writes primary and locator manifests for custom install dirs", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const result = persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        chatConfig: { telegram: { token: "x" } },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) =>
          fallback === null ? { koishi: { telegram: { token: "legacy" } } } : fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );
    assert.equal(result.manifestPath, path.join(installDir, "installer.json"));
    assert.equal(
      result.locatorManifestPath,
      path.join(ownerHome, ".rin", "installer.json"),
    );
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map((entry) => entry.filePath).sort(),
      [result.manifestPath, result.locatorManifestPath].sort(),
    );
    assert.equal(writes[0].value.defaultProvider, "openai");
    assert.equal(writes[0].value.defaultModel, "gpt");
    assert.equal(writes[0].value.defaultThinkingLevel, "medium");
    assert.equal("koishi" in writes[0].value, false);
  });
});

test("persist reconcileInstallerManifest avoids duplicate writes for default install dirs", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const installDir = path.join(ownerHome, ".rin");
    const writes = [];
    const result = persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );
    assert.equal(result.manifestPath, result.locatorManifestPath);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filePath, path.join(installDir, "installer.json"));
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

test("persist persistInstallerOutputs normalizes malformed chat roots before merging adapters", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "operator",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        chatConfig: { telegram: { token: "fresh-token" } },
        authData: { apiKey: "secret" },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (filePath, fallback) => {
          if (filePath === path.join(dir, "settings.json")) {
            return { chat: "broken", koishi: { telegram: { token: "legacy" } } };
          }
          if (filePath === path.join(dir, "auth.json")) {
            return { existing: true };
          }
          return fallback;
        },
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: (_filePath, fallback) => fallback,
        writeLaunchersForUser: () => ({
          rinPath: "/tmp/rin",
          rinInstallPath: "/tmp/rin-install",
        }),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    const settingsWrite = writes.find((entry) => entry.filePath === result.settingsPath);
    assert.ok(settingsWrite);
    assert.deepEqual(settingsWrite.value.chat, {
      telegram: { token: "fresh-token" },
    });
    assert.equal("koishi" in settingsWrite.value, false);

    const authWrite = writes.find((entry) => entry.filePath === result.authPath);
    assert.ok(authWrite);
    assert.deepEqual(authWrite.value, { existing: true, apiKey: "secret" });
  });
});
