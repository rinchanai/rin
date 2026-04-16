import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const { WorkerPool } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "worker-pool.js"),
  ).href
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeTempDir(prefix) {
  const root = process.env.RIN_TEST_TMPDIR || "/home/rin/tmp";
  await fs.mkdir(root, { recursive: true });
  return await fs.mkdtemp(path.join(root, prefix));
}

test("getRestorableSessionSelectors keeps live session workers and remembers turn state", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
  await fs.writeFile(
    workerPath,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.resolveWorkerForCommand(
    { socket: { destroyed: false, write() {} }, clientBuffer: "" },
    { type: "new_session" },
  );
  worker.sessionFile = "/tmp/test-session.jsonl";
  worker.isStreaming = false;

  assert.deepEqual(pool.getRestorableSessionSelectors(), [
    { sessionFile: "/tmp/test-session.jsonl", resumeTurn: false },
  ]);

  worker.isStreaming = true;
  assert.deepEqual(pool.getRestorableSessionSelectors(), [
    { sessionFile: "/tmp/test-session.jsonl", resumeTurn: true },
  ]);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("detached worker survives eviction while response is pending", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
  await fs.writeFile(
    workerPath,
    String.raw`process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { ok: true },
      }) + '\n');
    }, 50);
  }
});
setInterval(() => {}, 1000);
`,
  );

  const writes = [];
  const connection = {
    socket: {
      destroyed: false,
      write(value) {
        writes.push(String(value));
      },
    },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.resolveWorkerForCommand(connection, {
    type: "new_session",
  });
  pool.requestWorker(
    worker,
    connection,
    { id: "req_1", type: "get_commands" },
    false,
  );
  pool.evictDetachedWorkers();

  await sleep(200);

  assert.equal(writes.length > 0, true);
  const payload = JSON.parse(writes[0]);
  assert.equal(payload.id, "req_1");
  assert.equal(payload.success, true);

  await sleep(80);
  pool.evictDetachedWorkers();
  assert.equal(pool.getStatusSnapshot().workerCount, 0);
});

test("attached session worker auto-recovers without dropping the daemon connection", async () => {
  const dir = await makeTempDir("rin-worker-pool-");
  const workerPath = path.join(dir, "worker.mjs");
  const firstRunMarker = path.join(dir, "first-run.txt");
  await fs.writeFile(
    workerPath,
    String.raw`import fs from 'node:fs';
import path from 'node:path';
const marker = ${JSON.stringify(firstRunMarker)};
const firstRun = !fs.existsSync(marker);
if (firstRun) fs.writeFileSync(marker, 'done');
process.stdin.setEncoding('utf8');
let buffer='';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === 'get_state' && firstRun) {
      process.exit(9);
    }
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data: command.type === 'switch_session'
        ? { cancelled: false }
        : { sessionFile: '/tmp/recovered.jsonl', sessionId: 'recovered-session', isStreaming: false, isCompacting: false },
    }) + '\n');
  }
});
setInterval(() => {}, 1000);
`,
  );

  const writes = [];
  const connection = {
    socket: {
      destroyed: false,
      write(value) {
        writes.push(String(value));
      },
    },
    clientBuffer: "",
  };

  const pool = new WorkerPool({ workerPath, cwd: dir, gcIdleMs: 50 });
  const worker = pool.resolveWorkerForCommand(connection, { type: "new_session" });
  worker.sessionFile = "/tmp/recovered.jsonl";
  worker.sessionId = "recovered-session";
  pool.forwardToWorker(connection, worker, { id: "req_1", type: "get_state" });

  for (let i = 0; i < 20; i += 1) {
    if (writes.some((value) => JSON.parse(value).type === "session_recovered")) break;
    await sleep(50);
  }

  const payloads = writes.map((value) => JSON.parse(value));
  assert.deepEqual(
    payloads.map((payload) => payload.type),
    ["session_recovering", "response", "session_recovered"],
  );
  assert.equal(payloads[0].resumeTurn, false);
  assert.equal(payloads[1].error, "rin_session_recovering");
  assert.equal(payloads[2].sessionFile, "/tmp/recovered.jsonl");
  assert.equal(pool.getStatusSnapshot().workerCount, 1);

  pool.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
});
