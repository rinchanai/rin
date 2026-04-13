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
const applyPlan = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "apply-plan.js"),
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
        koishiConfig: { telegram: { token: "x" } },
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
    assert.equal(writes[0].value.targetUser, "demo");
    assert.equal(writes[0].value.installDir, dir);
    assert.equal(writes[0].value.defaultProvider, "openai");
    assert.equal(writes[0].value.defaultModel, "gpt");
    assert.equal(writes[0].value.defaultThinkingLevel, "medium");
    assert.deepEqual(writes[0].value.koishi, { telegram: { token: "x" } });
  });
});

test("persist reconcileInstallerManifest uses elevated writes and removes legacy manifests", async () => {
  await withTempDir(async (dir) => {
    const privilegedWrites = [];
    const privilegedCommands = [];
    const result = persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir: dir,
        elevated: true,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: async () => {
          throw new Error("ensureDir should not run for elevated writes");
        },
        readInstallerJson: (filePath, fallback) =>
          filePath.endsWith(path.join("config", "installer.json"))
            ? { defaultProvider: "openai" }
            : fallback,
        writeJsonFileWithPrivilege: (filePath, value, ownerUser, ownerGroup) =>
          privilegedWrites.push({ filePath, value, ownerUser, ownerGroup }),
        writeJsonFile: () => {
          throw new Error("plain write should not run for elevated writes");
        },
        runPrivileged: (command, args) =>
          privilegedCommands.push({ command, args }),
      },
    );
    assert.equal(privilegedWrites.length, 1);
    assert.equal(privilegedWrites[0].ownerUser, "demo");
    assert.equal(privilegedWrites[0].ownerGroup, 1000);
    assert.equal(privilegedWrites[0].value.defaultProvider, "openai");
    assert.deepEqual(privilegedCommands, [
      { command: "rm", args: ["-f", result.legacyManifestPath] },
    ]);
  });
});

test("persistInstallerOutputs merges settings auth launcher metadata and launchers coherently", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "builder",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt-5",
        thinkingLevel: "high",
        koishiConfig: {
          telegram: { token: "tg-token" },
          onebot: { endpoint: "http://127.0.0.1:5700" },
        },
        authData: { github: { type: "oauth" } },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: () => {},
        readInstallerJson: (filePath, fallback) => {
          if (filePath.endsWith("settings.json")) {
            return {
              quietStartup: true,
              koishi: { telegram: { token: "old" } },
            };
          }
          if (filePath.endsWith("auth.json")) {
            return { existing: { type: "api_key", key: "secret" } };
          }
          return fallback;
        },
        writeJsonFileWithPrivilege: () => {
          throw new Error("unexpected privileged write");
        },
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        appConfigDirForUser: (userName) => path.join(dir, ".config", userName),
        readJsonFile: (_filePath, fallback) => ({ ...fallback, theme: "dark" }),
        writeLaunchersForUser: (userName, installDir) => ({
          rinPath: path.join(installDir, `launcher-${userName}`),
          rinInstallPath: path.join(installDir, `launcher-install-${userName}`),
        }),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    const settingsWrite = writes.find((entry) =>
      entry.filePath.endsWith("settings.json"),
    );
    const authWrite = writes.find((entry) =>
      entry.filePath.endsWith("auth.json"),
    );
    const launcherWrite = writes.find((entry) =>
      entry.filePath.endsWith(path.join("builder", "install.json")),
    );

    assert.deepEqual(settingsWrite?.value, {
      quietStartup: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "high",
      koishi: {
        telegram: { token: "tg-token" },
        onebot: { endpoint: "http://127.0.0.1:5700" },
      },
    });
    assert.deepEqual(authWrite?.value, {
      existing: { type: "api_key", key: "secret" },
      github: { type: "oauth" },
    });
    assert.equal(launcherWrite?.value.defaultTargetUser, "demo");
    assert.equal(launcherWrite?.value.defaultInstallDir, dir);
    assert.equal(launcherWrite?.value.installedBy, "builder");
    assert.ok(result.manifestPath.endsWith(path.join(dir, "installer.json")));
    assert.ok(result.rinPath.endsWith("launcher-builder"));
    assert.ok(result.rinInstallPath.endsWith("launcher-install-builder"));
  });
});

test("apply-plan child result reader returns parsed json on success", async () => {
  await withTempDir(async (dir) => {
    const resultPath = path.join(dir, "result.json");
    const errorPath = path.join(dir, "error.txt");
    await fs.writeFile(resultPath, '{"ok":true}\n', "utf8");
    await fs.writeFile(errorPath, "ignored\n", "utf8");

    assert.deepEqual(
      applyPlan.readFinalizeInstallChildResult(resultPath, errorPath, 0),
      { ok: true },
    );
  });
});

test("apply-plan child result reader surfaces child error output", async () => {
  await withTempDir(async (dir) => {
    const resultPath = path.join(dir, "result.json");
    const errorPath = path.join(dir, "error.txt");
    await fs.writeFile(errorPath, "child failed loudly\n", "utf8");

    assert.throws(
      () => applyPlan.readFinalizeInstallChildResult(resultPath, errorPath, 1),
      /child failed loudly/,
    );
  });
});

test("apply-plan child result reader falls back when child error output is missing", async () => {
  await withTempDir(async (dir) => {
    const resultPath = path.join(dir, "result.json");
    const errorPath = path.join(dir, "missing-error.txt");

    assert.throws(
      () => applyPlan.readFinalizeInstallChildResult(resultPath, errorPath, 1),
      /rin_installer_apply_failed/,
    );
  });
});

test("apply-plan child result reader rejects missing or invalid success payloads", async () => {
  await withTempDir(async (dir) => {
    const resultPath = path.join(dir, "result.json");
    const errorPath = path.join(dir, "error.txt");
    await fs.writeFile(errorPath, "ignored\n", "utf8");

    assert.throws(
      () => applyPlan.readFinalizeInstallChildResult(resultPath, errorPath, 0),
      /rin_installer_apply_result_missing/,
    );

    await fs.writeFile(resultPath, "not-json\n", "utf8");
    assert.throws(
      () => applyPlan.readFinalizeInstallChildResult(resultPath, errorPath, 0),
      /rin_installer_apply_result_missing/,
    );
  });
});
