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
const rpc = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "rpc.js")).href
);
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href
);
const launch = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "launch.js")).href
);
const installPaths = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "paths.js"))
    .href
);

test("rpc helpers build success and failure envelopes", () => {
  assert.deepEqual(rpc.ok("1", "get_state", { ok: true }), {
    id: "1",
    type: "response",
    command: "get_state",
    success: true,
    data: { ok: true },
  });
  assert.deepEqual(rpc.fail("2", "prompt", new Error("boom")), {
    id: "2",
    type: "response",
    command: "prompt",
    success: false,
    error: "boom",
  });
});

test("shared resolveParsedArgs keeps passthrough and install defaults coherent", () => {
  const parsed = shared.resolveParsedArgs(
    "",
    { std: true, tmux: "", tmuxList: false, user: "demo" },
    ["--std", "--foo", "bar"],
  );
  assert.equal(parsed.targetUser, "demo");
  assert.equal(parsed.std, true);
  assert.deepEqual(parsed.passthrough, ["--foo", "bar"]);
  assert.equal(
    shared.installConfigPath(),
    installPaths.launcherMetadataPathForHome(os.homedir()),
  );
  assert.equal(
    shared.resolveInstallDirForTarget({ ...parsed, installDir: "" }),
    installPaths.defaultInstallDirForHome(os.homedir()),
  );
});

test("shared loadInstallConfigForHome prefers launcher metadata candidates and recovers installer manifests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rin-shared-home-"));
  try {
    await fs.mkdir(path.join(home, ".rin"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".rin", "installer.json"),
      JSON.stringify({ targetUser: "demo" }),
      "utf8",
    );
    assert.deepEqual(shared.loadInstallConfigForHome(home), {
      defaultTargetUser: "demo",
      defaultInstallDir: installPaths.defaultInstallDirForHome(home),
    });

    await fs.mkdir(path.join(home, ".config", "rin"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".config", "rin", "install.json"),
      JSON.stringify({
        defaultTargetUser: "launcher-demo",
        defaultInstallDir: "/srv/launcher-demo",
      }),
      "utf8",
    );
    assert.deepEqual(shared.loadInstallConfigForHome(home), {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/launcher-demo",
    });

    await fs.rm(path.join(home, ".config", "rin", "install.json"), {
      force: true,
    });
    await fs.mkdir(path.join(home, "Library", "Application Support", "rin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(home, "Library", "Application Support", "rin", "install.json"),
      JSON.stringify({
        defaultTargetUser: "mac-launcher-demo",
        defaultInstallDir: "/srv/mac-launcher-demo",
      }),
      "utf8",
    );
    assert.deepEqual(shared.loadInstallConfigForHome(home), {
      defaultTargetUser: "mac-launcher-demo",
      defaultInstallDir: "/srv/mac-launcher-demo",
    });

    await fs.rm(
      path.join(home, "Library", "Application Support", "rin", "install.json"),
      { force: true },
    );
    await fs.rm(path.join(home, ".rin", "installer.json"), { force: true });
    await fs.mkdir(path.join(home, ".rin", "config"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".rin", "config", "installer.json"),
      JSON.stringify({
        targetUser: "demo",
        installDir: "/srv/rin-demo",
      }),
      "utf8",
    );
    assert.deepEqual(shared.loadInstallConfigForHome(home), {
      defaultTargetUser: "demo",
      defaultInstallDir: "/srv/rin-demo",
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("tmux socket args target the caller-owned hidden socket", () => {
  assert.deepEqual(launch.buildTmuxSocketArgs("demo"), ["-L", "rin-demo"]);
});

test("tui runtime env targets the target user's direct daemon socket", () => {
  const currentUser = os.userInfo().username;
  const installDir = installPaths.defaultInstallDirForHome(os.homedir());
  const env = launch.buildTuiRuntimeEnv(currentUser, "THE_cattail", installDir);
  assert.equal(env.RIN_DIR, installDir);
  assert.equal(env.PI_CODING_AGENT_DIR, installDir);
  assert.equal(env.RIN_INVOKING_SYSTEM_USER, "THE_cattail");
  assert.ok(String(env.RIN_DAEMON_SOCKET_PATH || "").includes("rin-daemon"));
  assert.ok(!String(env.RIN_DAEMON_SOCKET_PATH || "").includes("bridge.sock"));
});

test("tmux list targets hidden Rin sessions", () => {
  assert.deepEqual(launch.buildTmuxListArgs(["-L", "rin-demo"]), [
    "tmux",
    "-L",
    "rin-demo",
    "list-sessions",
    "-F",
    "#S",
  ]);
});
