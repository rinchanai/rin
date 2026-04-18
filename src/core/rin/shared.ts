import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { safeString } from "../text-utils.js";

import { bridgeDaemonSocketPath } from "../rin-lib/common.js";
import {
  canConnectDaemonSocket,
  requestDaemonCommand,
} from "../rin-daemon/client.js";
import { PI_AGENT_DIR_ENV, RIN_DIR_ENV } from "../rin-lib/runtime.js";
import {
  buildUserShell,
  readPasswdUser,
  shellQuote,
  socketPathForUser,
  targetUserRuntimeEnv,
} from "../rin-lib/system.js";
import { detectCurrentUser, finalizeCoreUpdate } from "../rin-install/main.js";
import { loadInstallRecordFromCandidates } from "../rin-install/install-record.js";
import {
  defaultInstallDirForHome,
  installRecordCandidatesForHome,
  launcherMetadataPathForHome,
  managedSystemdUnitCandidates,
} from "../rin-install/paths.js";

export type ParsedArgs = {
  command:
    | ""
    | "update"
    | "start"
    | "stop"
    | "restart"
    | "doctor"
    | "usage"
    | "memory-index";
  targetUser: string;
  installDir: string;
  std: boolean;
  tmuxSession: string;
  tmuxList: boolean;
  passthrough: string[];
  explicitUser: boolean;
  hasSavedInstall: boolean;
};

type InstallConfig = {
  defaultTargetUser?: string;
  defaultInstallDir?: string;
};

export { safeString };

export function repoRootFromHere() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
}

export function runCommand(command: string, args: string[], options: any = {}) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`terminated:${signal}`));
      resolve(code ?? 0);
    });
  });
}

export function installConfigPath() {
  return launcherMetadataPathForHome(os.homedir());
}

export function loadInstallConfigForHome(home = os.homedir()): InstallConfig {
  return (
    loadInstallRecordFromCandidates(
      home,
      installRecordCandidatesForHome(home),
      (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")),
    ) || {}
  );
}

export function loadInstallConfig() {
  return loadInstallConfigForHome(os.homedir());
}

type TargetExecutionContextBase = ReturnType<typeof daemonControlContext>;
export type TargetExecutionContext = TargetExecutionContextBase & {
  currentUser: string;
  isTargetUser: boolean;
  exec: (argv: string[], options?: any) => void;
  capture: (argv: string[], options?: any) => string;
  canConnectSocket: () => Promise<boolean>;
  queryDaemonStatus: () => Promise<any>;
};

export function createTargetExecutionContext(
  parsed: ParsedArgs,
): TargetExecutionContext {
  const base = daemonControlContext(parsed);
  const currentUser = os.userInfo().username;
  const isTargetUser = !base.targetUser || base.targetUser === currentUser;

  const exec = (argv: string[], options: any = {}) => {
    const launch = buildUserShell(base.targetUser, argv, base.runtimeEnv);
    execFileSync(launch.command, launch.args, {
      stdio: "inherit",
      env: launch.env,
      cwd: base.repoRoot,
      ...options,
    });
  };

  const capture = (argv: string[], options: any = {}) => {
    const launch = buildUserShell(base.targetUser, argv, base.runtimeEnv);
    return execFileSync(launch.command, launch.args, {
      encoding: "utf8",
      env: launch.env,
      cwd: base.repoRoot,
      ...options,
    });
  };

  const canConnectSocketInContext = async () => {
    if (isTargetUser)
      return await canConnectDaemonSocket(base.socketPath, 500);
    try {
      capture(
        [
          process.execPath,
          "-e",
          `const net=require('node:net');const s=net.createConnection(${JSON.stringify(base.socketPath)});let done=false;const finish=(ok)=>{if(done)return;done=true;try{s.destroy()}catch{};process.exit(ok?0:1)};s.once('connect',()=>finish(true));s.once('error',()=>finish(false));setTimeout(()=>finish(false),500);`,
        ],
        { stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  };

  const queryDaemonStatusInContext = async () => {
    if (!isTargetUser) {
      try {
        const raw = capture([
          process.execPath,
          "-e",
          `const net=require('node:net');const socketPath=${JSON.stringify(base.socketPath)};const socket=net.createConnection(socketPath);let buffer='';let settled=false;const finish=(value)=>{if(settled)return;settled=true;try{socket.destroy()}catch{};process.stdout.write(JSON.stringify(value===undefined?null:value));};socket.once('error',()=>finish(undefined));socket.on('data',(chunk)=>{buffer+=String(chunk);while(true){const idx=buffer.indexOf('\\n');if(idx<0)break;let line=buffer.slice(0,idx);buffer=buffer.slice(idx+1);if(line.endsWith('\\r'))line=line.slice(0,-1);if(!line.trim())continue;try{const payload=JSON.parse(line);if(payload?.type==='response'&&payload?.command==='daemon_status'){finish(payload.success===true?payload.data:undefined);return;}}catch{}}});socket.once('connect',()=>{socket.write(JSON.stringify({id:'doctor_1',type:'daemon_status'})+'\\n');setTimeout(()=>finish(undefined),1500);});`,
        ]);
        const decoded = JSON.parse(String(raw || "null"));
        return decoded == null ? undefined : decoded;
      } catch {
        return undefined;
      }
    }

    try {
      return await requestDaemonCommand(
        { id: "doctor_1", type: "daemon_status" },
        { socketPath: base.socketPath, timeoutMs: 1500 },
      );
    } catch {
      return undefined;
    }
  };

  return {
    ...base,
    currentUser,
    isTargetUser,
    exec,
    capture,
    canConnectSocket: canConnectSocketInContext,
    queryDaemonStatus: queryDaemonStatusInContext,
  };
}

export async function ensureDaemonAvailable(context: TargetExecutionContext) {
  if (await context.canConnectSocket()) return;

  if (context.systemctl) {
    for (const unit of managedSystemdUnitCandidates(context.targetUser)) {
      try {
        context.exec([context.systemctl, "--user", "start", unit]);
        break;
      } catch {}
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      if (await context.canConnectSocket()) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  const daemonEntry = path.join(
    context.repoRoot,
    "dist",
    "app",
    "rin-daemon",
    "daemon.js",
  );
  const launch = buildUserShell(
    context.targetUser,
    [process.execPath, daemonEntry],
    context.runtimeEnv,
  );
  const child = spawn(launch.command, launch.args, {
    cwd: context.repoRoot,
    env: launch.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (await context.canConnectSocket()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    `rin_daemon_unavailable: failed to start daemon for ${context.targetUser}`,
  );
}

export function requireTool(name: string, paths: string[] = []) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    return (
      execFileSync("sh", ["-lc", `command -v ${shellQuote(name)}`], {
        encoding: "utf8",
      }).trim() || name
    );
  } catch {
    throw new Error(`rin_missing_required_tool:${name}`);
  }
}

function runCommandSync(command: string, args: string[], options: any = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function updateWorkRoot() {
  const base =
    safeString(process.env.XDG_CACHE_HOME).trim() ||
    path.join(os.homedir(), ".cache");
  const dir = path.join(base, "rin-update");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupStaleUpdateWorkDirs(
  workRoot: string,
  options: {
    keepPaths?: string[];
    nowMs?: number;
    staleAfterMs?: number;
  } = {},
) {
  const keepPaths = new Set(
    (options.keepPaths || []).map((item) => path.resolve(item)),
  );
  const nowMs = Number.isFinite(options.nowMs)
    ? Number(options.nowMs)
    : Date.now();
  const staleAfterMs = Number.isFinite(options.staleAfterMs)
    ? Math.max(0, Number(options.staleAfterMs))
    : 12 * 60 * 60 * 1000;
  const removed: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(workRoot, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("work-")) continue;
    const fullPath = path.join(workRoot, entry.name);
    if (keepPaths.has(path.resolve(fullPath))) continue;
    try {
      const stat = fs.statSync(fullPath);
      const touchedAt = Number(stat.mtimeMs || 0);
      if (nowMs - touchedAt < staleAfterMs) continue;
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(fullPath);
    } catch {}
  }
  return removed;
}

export function resolveInstallDirForTarget(parsed: ParsedArgs) {
  const target = readPasswdUser(parsed.targetUser);
  return (
    parsed.installDir || defaultInstallDirForHome(target?.home || os.homedir())
  );
}

function daemonControlContext(parsed: ParsedArgs) {
  const repoRoot = repoRootFromHere();
  const installDir = resolveInstallDirForTarget(parsed);
  const targetUser = parsed.targetUser;
  const runtimeEnv = targetUserRuntimeEnv(targetUser, {
    [RIN_DIR_ENV]: installDir,
    [PI_AGENT_DIR_ENV]: installDir,
  });
  const systemctl =
    process.platform === "linux"
      ? fs.existsSync("/usr/bin/systemctl")
        ? "/usr/bin/systemctl"
        : fs.existsSync("/bin/systemctl")
          ? "/bin/systemctl"
          : ""
      : "";
  const socketPath =
    targetUser === os.userInfo().username
      ? socketPathForUser(targetUser)
      : bridgeDaemonSocketPath(installDir);
  return {
    repoRoot,
    installDir,
    targetUser,
    runtimeEnv,
    systemctl,
    socketPath,
  };
}

export function collectTuiPassthroughArgs(argv: string[]) {
  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--user" || arg === "-u" || arg === "--tmux" || arg === "-t") {
      i += 1;
      continue;
    }
    if (arg === "--std" || arg === "--tmux-list") continue;
    passthrough.push(arg);
  }
  return passthrough;
}

export function resolveParsedArgs(
  command: ParsedArgs["command"],
  options: any,
  rawArgv: string[],
): ParsedArgs {
  const installConfig = loadInstallConfig();
  const targetUser = safeString(options.user).trim();
  return {
    command,
    targetUser:
      targetUser ||
      safeString(installConfig.defaultTargetUser).trim() ||
      os.userInfo().username,
    installDir: safeString(installConfig.defaultInstallDir).trim(),
    std: Boolean(options.std),
    tmuxSession: safeString(options.tmux).trim(),
    tmuxList: Boolean(options.tmuxList),
    passthrough: command ? [] : collectTuiPassthroughArgs(rawArgv),
    explicitUser: Boolean(targetUser),
    hasSavedInstall: Boolean(
      safeString(installConfig.defaultTargetUser).trim() ||
      safeString(installConfig.defaultInstallDir).trim(),
    ),
  };
}

export async function runUpdate(parsed: ParsedArgs) {
  const installDir = resolveInstallDirForTarget(parsed);

  const curl =
    process.platform === "win32"
      ? ""
      : fs.existsSync("/usr/bin/curl")
        ? "/usr/bin/curl"
        : "";
  const wget =
    process.platform === "win32"
      ? ""
      : fs.existsSync("/usr/bin/wget")
        ? "/usr/bin/wget"
        : "";
  const tar = requireTool("tar", ["/usr/bin/tar", "/bin/tar"]);
  const npm = requireTool("npm", ["/usr/bin/npm", "/bin/npm"]);
  const workRoot = updateWorkRoot();
  cleanupStaleUpdateWorkDirs(workRoot);
  const tempRoot = fs.mkdtempSync(path.join(workRoot, "work-"));
  const tmpDir = path.join(tempRoot, "tmp");
  const archivePath = path.join(tempRoot, "rin.tar.gz");
  const sourceRoot = path.join(tempRoot, "src");
  const buildEnv = {
    ...process.env,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
  };

  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    if (curl) {
      runCommandSync(curl, [
        "-fsSL",
        "https://github.com/rinchanai/rin/archive/refs/heads/main.tar.gz",
        "-o",
        archivePath,
      ]);
    } else if (wget) {
      runCommandSync(wget, [
        "-qO",
        archivePath,
        "https://github.com/rinchanai/rin/archive/refs/heads/main.tar.gz",
      ]);
    } else {
      throw new Error("rin_missing_required_tool:curl_or_wget");
    }
    runCommandSync(tar, [
      "-xzf",
      archivePath,
      "-C",
      sourceRoot,
      "--strip-components=1",
    ]);

    if (fs.existsSync(path.join(sourceRoot, "package-lock.json"))) {
      runCommandSync(npm, ["ci", "--no-fund", "--no-audit"], {
        cwd: sourceRoot,
        env: buildEnv,
      });
    } else {
      runCommandSync(npm, ["install", "--no-fund", "--no-audit"], {
        cwd: sourceRoot,
        env: buildEnv,
      });
    }
    runCommandSync(npm, ["run", "build"], { cwd: sourceRoot, env: buildEnv });

    console.log(
      "rin update: updating core runtime only (CLI launcher and installer are unchanged)",
    );
    const result = await finalizeCoreUpdate({
      currentUser: detectCurrentUser(),
      targetUser: parsed.targetUser,
      installDir,
      sourceRoot,
    });
    console.log(`rin update complete: ${result.publishedRuntime.releaseRoot}`);
    if (result.installedDocsDir)
      console.log(
        `rin update: refreshed rin docs = ${result.installedDocsDir}`,
      );
    if (Array.isArray(result.installedDocs?.pi)) {
      for (const item of result.installedDocs.pi)
        console.log(`rin update: refreshed pi docs = ${item}`);
    }
    console.log(
      `rin update: pruned old releases = ${result.prunedReleases.removed.length}`,
    );
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
}
