import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const service = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "service.js"),
  ).href
);
const paths = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "paths.js"),
  ).href
);

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "rin-web-search-service-"),
  );
  try {
    await fn(dir);
  } finally {
    delete process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV];
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("web-search service reuses existing live instance state and exposes stable status", async () => {
  await withTempDir(async (stateRoot) => {
    paths.writeRuntimeBootstrapState(stateRoot, {
      ready: true,
      installedAt: "2026-04-14T08:00:00.000Z",
      pythonBin: "/venv/bin/python",
      sourceDir: "/srv/searxng/src",
    });
    paths.writeInstanceState(stateRoot, "demo", {
      pid: process.pid,
      ownerPid: process.pid,
      baseUrl: "http://127.0.0.1:9911",
      port: 9911,
      startedAt: "2026-04-14T08:05:00.000Z",
      settingsPath: "/srv/searxng/settings.yml",
    });

    const reused = await service.ensureSearxngSidecar(stateRoot, {
      instanceId: "demo",
    });
    assert.deepEqual(reused, {
      ok: true,
      instanceId: "demo",
      baseUrl: "http://127.0.0.1:9911",
      reused: true,
    });
    assert.equal(
      process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV],
      "http://127.0.0.1:9911",
    );

    const status = service.getSearxngSidecarStatus(stateRoot);
    assert.deepEqual(status, {
      root: path.join(path.resolve(stateRoot), "data", "web-search"),
      runtime: {
        ready: true,
        installedAt: "2026-04-14T08:00:00.000Z",
        pythonBin: "/venv/bin/python",
        sourceDir: "/srv/searxng/src",
      },
      instances: [
        {
          instanceId: "demo",
          pid: process.pid,
          alive: true,
          baseUrl: "http://127.0.0.1:9911",
          port: 9911,
          startedAt: "2026-04-14T08:05:00.000Z",
          ownerPid: process.pid,
          statePath: paths.instanceStateFileForState(stateRoot, "demo"),
          settingsPath: "/srv/searxng/settings.yml",
        },
      ],
    });
  });
});

test("web-search service stop clears matching env state and cleanup removes orphan instances", async () => {
  await withTempDir(async (stateRoot) => {
    paths.writeInstanceState(stateRoot, "demo", {
      pid: 0,
      ownerPid: process.pid,
      baseUrl: "http://127.0.0.1:9922",
      port: 9922,
      settingsPath: "/tmp/settings.yml",
    });
    process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV] = "http://127.0.0.1:9922";

    const stopped = await service.stopSearxngSidecar(stateRoot, {
      instanceId: "demo",
    });
    assert.deepEqual(stopped, { ok: true, pid: 0 });
    assert.equal(process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV], undefined);
    assert.equal(
      fs.existsSync(paths.instanceRootForState(stateRoot, "demo")),
      false,
    );

    const logs = [];
    paths.writeInstanceState(stateRoot, "orphaned", {
      pid: 0,
      ownerPid: 999999,
      baseUrl: "http://127.0.0.1:9933",
    });
    const cleaned = await service.cleanupOrphanSearxngSidecars(stateRoot, {
      logger: { info: (line) => logs.push(line) },
    });
    assert.deepEqual(cleaned, {
      ok: true,
      cleaned: [{ instanceId: "orphaned", pid: 0, ownerPid: 999999 }],
    });
    assert.equal(
      fs.existsSync(paths.instanceRootForState(stateRoot, "orphaned")),
      false,
    );
    assert.match(logs[0], /cleaned orphan instance=orphaned/);

    assert.deepEqual(await service.stopSearxngSidecar(stateRoot), {
      ok: false,
      error: "web_search_instance_required",
    });
  });
});
