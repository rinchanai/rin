import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const query = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "query.js"),
  ).href
);
const paths = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "paths.js"),
  ).href
);
const service = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "service.js"),
  ).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp("/home/rin/tmp/rin-web-search-test-");
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("web search query helpers normalize request", () => {
  const req = query.normalizeSearchRequest({
    q: "  hello ",
    limit: 99,
    domains: ["a.com", "a.com", "b.com"],
  });
  assert.equal(req.q, "hello");
  assert.equal(req.limit, 8);
  assert.deepEqual(req.domains, ["a.com", "b.com"]);
  assert.equal(query.buildSearchQuery(req), "hello site:a.com site:b.com");
});

test("web search query helpers discard invalid freshness", () => {
  const req = query.normalizeSearchRequest({
    q: " demo ",
    freshness: "decade",
    language: "  zh-CN  ",
  });
  assert.equal(req.q, "demo");
  assert.equal(req.language, "zh-CN");
  assert.equal(req.freshness, undefined);
});

test("web search paths derive runtime locations", () => {
  const root = "/tmp/demo";
  assert.ok(
    paths
      .runtimeRootForState(root)
      .endsWith(path.join("data", "web-search", "runtime")),
  );
  assert.ok(
    paths
      .instanceStateFileForState(root, "abc")
      .endsWith(path.join("instances", "abc", "state.json")),
  );
});

test("web search orphan cleanup removes full instance root", async () => {
  await withTempDir(async (dir) => {
    const instanceRoot = paths.instanceRootForState(dir, "demo");
    await fs.mkdir(instanceRoot, { recursive: true });
    await fs.writeFile(
      path.join(instanceRoot, "settings.yml"),
      "demo: true\n",
      "utf8",
    );
    paths.writeInstanceState(dir, "demo", {
      pid: 0,
      ownerPid: 999999,
      baseUrl: "http://127.0.0.1:9999",
      settingsPath: path.join(instanceRoot, "settings.yml"),
    });

    const result = await service.cleanupOrphanSearxngSidecars(dir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.cleaned, [
      { instanceId: "demo", pid: 0, ownerPid: 999999 },
    ]);
    await assert.rejects(fs.stat(instanceRoot));
  });
});
