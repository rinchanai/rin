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
    assert.equal(writes[0].value.defaultProvider, "openai");
    assert.equal(writes[0].value.defaultModel, "gpt");
    assert.equal(writes[0].value.defaultThinkingLevel, "medium");
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
