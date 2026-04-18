import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
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

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

function buildFakeSearxngNodeProgram(
  { readyServer = false, spawnCountFile = "", exitAfterMs = 0 } = {},
) {
  return [
    'const fs = require("node:fs");',
    spawnCountFile
      ? `fs.appendFileSync(${JSON.stringify(spawnCountFile)}, "spawn\\n");`
      : "",
    readyServer
      ? [
          'const http = require("node:http");',
          'const port = Number(process.env.SEARXNG_PORT || 0);',
          "const server = http.createServer((req, res) => {",
          'if (req.url === "/healthz") {',
          'res.writeHead(200, { "Content-Type": "text/plain" });',
          'res.end("OK");',
          "return;",
          "}",
          "res.writeHead(404);",
          'res.end("not found");',
          "});",
          'server.listen(port, "127.0.0.1");',
        ].join(" ")
      : "",
    exitAfterMs > 0 ? `setTimeout(() => process.exit(0), ${exitAfterMs});` : "",
    "setInterval(() => {}, 60000);",
  ]
    .filter(Boolean)
    .join(" ");
}

async function installArchiveFallbackToolchain(
  binDir,
  { readyServer = false, spawnCountFile = "", exitAfterMs = 0 } = {},
) {
  const nodeBin = JSON.stringify(process.execPath);
  const nodeProgram = JSON.stringify(
    buildFakeSearxngNodeProgram({ readyServer, spawnCountFile, exitAfterMs }),
  );
  await writeExecutable(
    path.join(binDir, "python3"),
    `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  venv="$3"
  /bin/mkdir -p "$venv/bin"
  /bin/cat > "$venv/bin/python" <<'EOF'
#!/bin/sh
node_bin=${nodeBin}
if [ "$1" = "-m" ] && [ "$2" = "searx.webapp" ]; then
  exec "$node_bin" -e ${nodeProgram}
fi
exit 0
EOF
  /bin/cat > "$venv/bin/pip" <<'EOF'
#!/bin/sh
exit 0
EOF
  /bin/chmod +x "$venv/bin/python" "$venv/bin/pip"
  exit 0
fi
exit 0
`,
  );
  await writeExecutable(
    path.join(binDir, "curl"),
    `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    out="$2"
    shift 2
    continue
  fi
  shift
done
: > "$out"
exit 0
`,
  );
  await writeExecutable(
    path.join(binDir, "tar"),
    `#!/bin/sh
target=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    target="$2"
    shift 2
    continue
  fi
  shift
done
/bin/mkdir -p "$target/searx"
printf 'flask\n' > "$target/requirements.txt"
printf '# test package\n' > "$target/searx/__init__.py"
exit 0
`,
  );
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

test("web search cleanup removes stale dead instances owned by a live process", async () => {
  await withTempDir(async (dir) => {
    const instanceRoot = paths.instanceRootForState(dir, "stale");
    await fs.mkdir(instanceRoot, { recursive: true });
    await fs.writeFile(
      path.join(instanceRoot, "settings.yml"),
      "demo: true\n",
      "utf8",
    );
    paths.writeInstanceState(dir, "stale", {
      pid: 999999,
      ownerPid: process.pid,
      baseUrl: "http://127.0.0.1:9999",
      settingsPath: path.join(instanceRoot, "settings.yml"),
    });

    const result = await service.cleanupOrphanSearxngSidecars(dir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.cleaned, [
      { instanceId: "stale", pid: 999999, ownerPid: process.pid },
    ]);
    await assert.rejects(fs.stat(instanceRoot));
  });
});

test("web search sidecar bootstrap falls back to archive download without git", async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await installArchiveFallbackToolchain(binDir, { readyServer: true });

    const previousPath = process.env.PATH;
    const previousBaseUrl = process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV];
    delete process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV];
    process.env.PATH = binDir;

    try {
      const result = await service.ensureSearxngSidecar(dir, {
        instanceId: "archive-fallback",
        timeoutMs: 2_000,
      });
      assert.equal(result.ok, true);
      assert.match(result.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

      const status = service.getSearxngSidecarStatus(dir);
      assert.equal(status.runtime.ready, true);
      await fs.stat(path.join(status.runtime.sourceDir, "requirements.txt"));
      await assert.rejects(fs.stat(path.join(status.runtime.sourceDir, ".git")));
      assert.equal(status.instances.length, 1);
      assert.equal(status.instances[0].instanceId, "archive-fallback");
      assert.equal(status.instances[0].alive, true);
    } finally {
      await service.stopSearxngSidecar(dir, {
        instanceId: "archive-fallback",
      });
      if (previousPath == null) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousBaseUrl == null) {
        delete process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV];
      } else {
        process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV] = previousBaseUrl;
      }
    }
  });
});

test("web search sidecar reuses a ready instance after waiting for the lock", async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, "bin");
    const spawnCountFile = path.join(dir, "spawn-count.log");
    await fs.mkdir(binDir, { recursive: true });
    await installArchiveFallbackToolchain(binDir, {
      readyServer: true,
      spawnCountFile,
      exitAfterMs: 1_500,
    });

    const previousPath = process.env.PATH;
    const previousBaseUrl = process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV];
    delete process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV];
    process.env.PATH = binDir;

    try {
      const [first, second] = await Promise.all([
        service.ensureSearxngSidecar(dir, {
          instanceId: "shared-instance",
          timeoutMs: 2_000,
        }),
        service.ensureSearxngSidecar(dir, {
          instanceId: "shared-instance",
          timeoutMs: 2_000,
        }),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(first.baseUrl, second.baseUrl);

      const spawnCount = (await fs.readFile(spawnCountFile, "utf8"))
        .split("\n")
        .filter(Boolean).length;
      assert.equal(spawnCount, 1);
    } finally {
      await service.stopSearxngSidecar(dir, {
        instanceId: "shared-instance",
      });
      if (previousPath == null) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousBaseUrl == null) {
        delete process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV];
      } else {
        process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV] = previousBaseUrl;
      }
    }
  });
});

test("web search sidecar waits for a healthy endpoint before succeeding", async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await installArchiveFallbackToolchain(binDir, { readyServer: false });

    const previousPath = process.env.PATH;
    const previousBaseUrl = process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV];
    delete process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV];
    process.env.PATH = binDir;

    try {
      await assert.rejects(
        service.ensureSearxngSidecar(dir, {
          instanceId: "not-ready",
          timeoutMs: 300,
        }),
        /searxng_start_timeout/,
      );

      const status = service.getSearxngSidecarStatus(dir);
      assert.equal(status.instances.length, 0);
      await assert.rejects(
        fs.stat(paths.instanceRootForState(dir, "not-ready")),
      );
    } finally {
      if (previousPath == null) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousBaseUrl == null) {
        delete process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV];
      } else {
        process.env[service.RIN_WEB_SEARCH_BASE_URL_ENV] = previousBaseUrl;
      }
    }
  });
});
