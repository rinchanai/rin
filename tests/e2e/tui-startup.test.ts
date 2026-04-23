import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const tuiPath = path.join(rootDir, "dist", "app", "rin-tui", "main.js");

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-tui-e2e-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("rpc tui startup suggests doctor and std mode on daemon socket refusal", async () => {
  await withTempDir(async (tempDir) => {
    const home = path.join(tempDir, "home");
    const agentDir = path.join(tempDir, "agent");
    const runtimeDir = path.join(tempDir, "runtime");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(runtimeDir, { recursive: true });

    const socketPath = path.join(runtimeDir, "daemon.sock");
    await fs.writeFile(socketPath, "", "utf8");

    await assert.rejects(
      execFileAsync(process.execPath, [tuiPath, "--rpc"], {
        cwd: rootDir,
        env: {
          ...process.env,
          HOME: home,
          XDG_CACHE_HOME: path.join(home, ".cache"),
          XDG_RUNTIME_DIR: runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, "bus")}`,
          RIN_DIR: agentDir,
          PI_CODING_AGENT_DIR: agentDir,
          RIN_DAEMON_SOCKET_PATH: socketPath,
          NO_COLOR: "1",
          TERM: "dumb",
        },
      }),
      (error: any) => {
        assert.equal(error.code, 1);
        const stderr = String(error.stderr || "");
        assert.match(
          stderr,
          /RPC TUI could not connect to the daemon \(connect ECONNREFUSED .*daemon\.sock\)\./,
        );
        assert.match(stderr, /Try `rin doctor`/);
        assert.match(stderr, /`rin --std`/);
        return true;
      },
    );
  });
});
