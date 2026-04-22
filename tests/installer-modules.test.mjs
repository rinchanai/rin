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
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "launcher-demo",
      installDir: "/srv/rin-demo",
    }),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      targetUser: "manifest-demo",
      defaultInstallDir: "/srv/rin-demo",
    }),
    {
      defaultTargetUser: "manifest-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "launcher-demo",
    }),
    {
      defaultTargetUser: "launcher-demo",
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

  const readCalls = [];
  assert.deepEqual(
    installRecord.loadInstallRecordFromCandidates(
      "/home/demo",
      ["broken", "empty", "manifest", "unused"],
      (filePath) => {
        readCalls.push(filePath);
        if (filePath === "broken") throw new Error("broken json");
        if (filePath === "empty") return [];
        if (filePath === "manifest") return { targetUser: "candidate-demo" };
        return { targetUser: "unused-demo" };
      },
    ),
    {
      defaultTargetUser: "candidate-demo",
      defaultInstallDir: "/home/demo/.rin",
    },
  );
  assert.deepEqual(readCalls, ["broken", "empty", "manifest"]);

  assert.deepEqual(
    installRecord.loadInstallRecordFromCandidates(
      "/home/demo",
      ["mixed", "unused"],
      (filePath) =>
        filePath === "mixed"
          ? { defaultTargetUser: "launcher-demo", installDir: "/srv/rin-demo" }
          : { targetUser: "unused-demo" },
    ),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
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

test("persist reconcileInstallerManifest persists release metadata when provided", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        release: {
          channel: "beta",
          version: "1.3.0-beta.2",
          branch: "release/1.3",
          ref: "1.3.0-beta.2",
          sourceLabel: "beta version 1.3.0-beta.2",
          archiveUrl: "https://example.com/release-1.3-beta.2.tgz",
          installedAt: "2026-04-20T10:00:00.000Z",
        },
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

    assert.equal(writes.length, 2);
    for (const entry of writes) {
      assert.deepEqual(entry.value.release, {
        channel: "beta",
        version: "1.3.0-beta.2",
        branch: "release/1.3",
        ref: "1.3.0-beta.2",
        sourceLabel: "beta version 1.3.0-beta.2",
        archiveUrl: "https://example.com/release-1.3-beta.2.tgz",
        installedAt: "2026-04-20T10:00:00.000Z",
      });
    }
  });
});

test("persist reconcileInstallerManifest skips malformed recovery candidates before reusing a prior manifest", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const readCalls = [];

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        provider: "openai",
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (filePath, fallback) => {
          readCalls.push(filePath);
          if (filePath === path.join(installDir, "installer.json")) return [];
          if (filePath === path.join(ownerHome, ".rin", "installer.json")) {
            return { preserved: true, defaultModel: "existing-model" };
          }
          return fallback;
        },
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );

    assert.deepEqual(readCalls, [
      path.join(installDir, "installer.json"),
      path.join(ownerHome, ".rin", "installer.json"),
    ]);
    assert.equal(writes.length, 2);
    for (const entry of writes) {
      assert.equal(entry.value.preserved, true);
      assert.equal(entry.value.defaultModel, "existing-model");
      assert.equal(entry.value.defaultProvider, "openai");
    }
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

test("persist reconcileInstallerManifest stores configured language in installer manifest", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const installDir = path.join(ownerHome, ".rin");
    const writes = [];
    const result = persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        language: "zh-CN",
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
    assert.equal(writes[0].value.defaultProvider, "openai");
    assert.equal(writes[0].value.defaultModel, "gpt");
    assert.equal(writes[0].value.defaultThinkingLevel, "medium");
    assert.equal(writes[0].value.language, "zh-CN");
  });
});

test("persist reconcileInstallerManifest preserves normalized legacy chat config when new chat config is malformed", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        provider: "openai",
        chatConfig: "broken",
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) =>
          fallback === null
            ? { koishi: { telegram: { token: "legacy" } } }
            : fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );

    assert.equal(writes.length, 2);
    for (const entry of writes) {
      assert.deepEqual(entry.value.chat, { telegram: { token: "legacy" } });
      assert.equal("koishi" in entry.value, false);
      assert.equal(entry.value.defaultProvider, "openai");
    }
  });
});

test("persistInstallerOutputs stores configured language in settings", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const launchWrites = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "alice",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        language: "zh-CN",
        chatConfig: {},
        authData: {},
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: (_filePath, fallback) => fallback,
        writeLaunchersForUser: () => {
          launchWrites.push(true);
          return {
            rinPath: path.join(dir, "rin"),
            rinInstallPath: path.join(dir, "rin-install"),
          };
        },
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    assert.equal(result.settingsPath.endsWith(path.join(dir, "settings.json")), true);
    assert.equal(launchWrites.length, 1);
    const settingsWrite = writes.find((entry) => entry.filePath === result.settingsPath);
    assert.ok(settingsWrite);
    assert.equal(settingsWrite.value.defaultProvider, "openai");
    assert.equal(settingsWrite.value.defaultModel, "gpt");
    assert.equal(settingsWrite.value.defaultThinkingLevel, "medium");
    assert.equal(settingsWrite.value.language, "zh-CN");
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

test("persist persistInstallerOutputs forwards release metadata into installer manifests", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];

    await persist.persistInstallerOutputs(
      {
        currentUser: "operator",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        chatConfig: null,
        authData: {},
        release: {
          channel: "git",
          version: "deadbeef",
          branch: "main",
          ref: "deadbeef",
          sourceLabel: "git ref deadbeef",
          archiveUrl: "https://example.com/rin-deadbeef.tar.gz",
          installedAt: "2026-04-20T11:00:00.000Z",
        },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
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

    const manifestWrites = writes.filter((entry) =>
      entry.filePath.endsWith(path.join(".rin", "installer.json")) ||
      entry.filePath.endsWith(path.join(dir, "installer.json")),
    );
    assert.equal(manifestWrites.length >= 1, true);
    for (const entry of manifestWrites) {
      assert.deepEqual(entry.value.release, {
        channel: "git",
        version: "deadbeef",
        branch: "main",
        ref: "deadbeef",
        sourceLabel: "git ref deadbeef",
        archiveUrl: "https://example.com/rin-deadbeef.tar.gz",
        installedAt: "2026-04-20T11:00:00.000Z",
      });
    }
  });
});

test("persist persistInstallerOutputs normalizes malformed auth and launcher metadata roots", async () => {
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
        chatConfig: null,
        authData: { apiKey: "secret" },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (filePath, fallback) => {
          if (filePath === path.join(dir, "auth.json")) return [];
          return fallback;
        },
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: () => [],
        writeLaunchersForUser: () => ({
          rinPath: "/tmp/rin",
          rinInstallPath: "/tmp/rin-install",
        }),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    const authWrite = writes.find((entry) => entry.filePath === result.authPath);
    assert.ok(authWrite);
    assert.deepEqual(authWrite.value, { apiKey: "secret" });

    const launcherWrite = writes.find(
      (entry) => entry.filePath === result.launcherPath,
    );
    assert.ok(launcherWrite);
    assert.deepEqual(launcherWrite.value, {
      defaultTargetUser: "demo",
      defaultInstallDir: dir,
      updatedAt: launcherWrite.value.updatedAt,
      installedBy: "operator",
    });
    assert.match(launcherWrite.value.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});
