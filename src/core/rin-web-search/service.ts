import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";

import { ensurePrivateDir } from "../platform/fs.js";
import { acquireProcessLock } from "../sidecar/common.js";
import { isPidAlive, safeString, sleep } from "../platform/process.js";
import {
  dataRootForState,
  instanceSettingsFileForState,
  instanceStateFileForState,
  listInstanceIds,
  readInstanceState,
  readRuntimeBootstrapState,
  removeInstanceRoot,
  runtimeLockPathForState,
  runtimePipBinForState,
  runtimePythonBinForState,
  runtimeRootForState,
  runtimeSourceDirForState,
  runtimeTmpDirForState,
  runtimeVenvDirForState,
  writeInstanceState,
  writeRuntimeBootstrapState,
  type RuntimeBootstrapState,
  type WebSearchInstanceState,
} from "./paths.js";
import {
  searchWeb as performWebSearch,
  safeText,
  type WebSearchRequest,
  type WebSearchResponse,
} from "./query.js";

const START_TIMEOUT_MS = 90_000;
const RIN_WEB_SEARCH_BASE_URL_ENV = "RIN_WEB_SEARCH_BASE_URL";

type LoggerLike = {
  info?: (message: string) => void;
};

type EnsureSearxngSidecarOptions = {
  logger?: LoggerLike;
  timeoutMs?: number;
  instanceId?: string;
};

type StopSearxngSidecarOptions = {
  logger?: LoggerLike;
  instanceId?: string;
};

type CleanupSearxngSidecarsOptions = {
  logger?: LoggerLike;
};

type SearxngRuntimeInstall = {
  sourceDir: string;
  pythonBin: string;
  pipBin: string;
  reused: boolean;
};

type NormalizedInstanceState = {
  pid: number;
  ownerPid: number;
  alive: boolean;
  baseUrl: string;
  port?: number;
  pythonBin: string;
  sourceDir: string;
  settingsPath: string;
  startedAt: string;
  statePath: string;
};

function logInfo(logger: LoggerLike | undefined, message: string): void {
  try {
    logger?.info?.(message);
  } catch {}
}

function toNumber(value: unknown): number {
  const numberValue = Number(value || 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function trimString(value: unknown): string {
  return safeString(value).trim();
}

function isLivePid(pid: unknown): boolean {
  const numberValue = toNumber(pid);
  return numberValue > 1 && isPidAlive(numberValue);
}

function normalizeInstanceState(
  stateRoot: string,
  instanceId: string,
  state: WebSearchInstanceState | null | undefined,
): NormalizedInstanceState {
  const pid = toNumber(state?.pid);
  const ownerPid = toNumber(state?.ownerPid);
  const port = toNumber(state?.port);
  return {
    pid,
    ownerPid,
    alive: isLivePid(pid),
    baseUrl: trimString(state?.baseUrl),
    port: port > 0 ? port : undefined,
    pythonBin: trimString(state?.pythonBin),
    sourceDir: trimString(state?.sourceDir),
    settingsPath: trimString(state?.settingsPath),
    startedAt: trimString(state?.startedAt),
    statePath: instanceStateFileForState(stateRoot, instanceId),
  };
}

function readNormalizedInstanceState(
  stateRoot: string,
  instanceId: string,
): NormalizedInstanceState {
  return normalizeInstanceState(
    stateRoot,
    instanceId,
    readInstanceState(stateRoot, instanceId),
  );
}

function clearResolvedBaseUrl(baseUrl: string): void {
  if (baseUrl && resolveWebSearchBaseUrl() === baseUrl) {
    delete process.env[RIN_WEB_SEARCH_BASE_URL_ENV];
  }
}

function removeStoredInstance(
  stateRoot: string,
  instanceId: string,
  baseUrl = "",
): void {
  removeInstanceRoot(stateRoot, instanceId);
  clearResolvedBaseUrl(baseUrl);
}

function findExecutableOnPath(name: string): string {
  const raw = trimString(process.env.PATH);
  const parts = raw ? raw.split(path.delimiter) : [];
  for (const dir of parts) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return "";
}

function runCommandSync(
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2] = {},
): ReturnType<typeof spawnSync> {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.status === 0) return result;
  const detail = safeText(
    result.stderr ||
      result.stdout ||
      result.error?.message ||
      `exit_${result.status}`,
  );
  throw new Error(`${path.basename(command)}:${detail}`);
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? Number(address.port || 0) : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function writeSearxngSettingsForInstance(
  stateRoot: string,
  instanceId: string,
  baseUrl: string,
  port: number,
): string {
  const settingsPath = instanceSettingsFileForState(stateRoot, instanceId);
  ensurePrivateDir(path.dirname(settingsPath));
  const secret = crypto
    .createHash("sha256")
    .update(`${baseUrl}|${stateRoot}|${instanceId}|rin-web-search`)
    .digest("hex")
    .slice(0, 32);
  const yaml = [
    "use_default_settings: true",
    "",
    "general:",
    "  enable_metrics: false",
    "",
    "search:",
    "  formats:",
    "    - html",
    "    - json",
    "",
    "server:",
    `  port: ${port}`,
    '  bind_address: "127.0.0.1"',
    `  base_url: ${JSON.stringify(`${baseUrl}/`)}`,
    `  secret_key: ${JSON.stringify(secret)}`,
    "  limiter: false",
    "  public_instance: false",
    "",
    "valkey:",
    "  url: false",
    "",
  ].join("\n");
  fs.writeFileSync(settingsPath, yaml, { mode: 0o600 });
  return settingsPath;
}

function ensureSearxngRuntimeInstalled(
  stateRoot: string,
  logger?: LoggerLike,
): SearxngRuntimeInstall {
  const runtimeDir = runtimeRootForState(stateRoot);
  const sourceDir = runtimeSourceDirForState(stateRoot);
  const venvDir = runtimeVenvDirForState(stateRoot);
  const tmpDir = runtimeTmpDirForState(stateRoot);
  const pythonBin = runtimePythonBinForState(stateRoot);
  const pipBin = runtimePipBinForState(stateRoot);
  const current = readRuntimeBootstrapState(stateRoot);
  if (
    current?.ready &&
    fs.existsSync(sourceDir) &&
    fs.existsSync(pythonBin) &&
    fs.existsSync(pipBin)
  ) {
    return { sourceDir, pythonBin, pipBin, reused: true };
  }

  ensurePrivateDir(runtimeDir);
  ensurePrivateDir(tmpDir);

  const python =
    findExecutableOnPath("python3") || findExecutableOnPath("python");
  if (!python) throw new Error("python_not_found");
  const git = findExecutableOnPath("git");
  if (!git) throw new Error("git_not_found");

  if (!fs.existsSync(path.join(sourceDir, ".git"))) {
    try {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    } catch {}
    logInfo(logger, "web-search: cloning searxng source");
    runCommandSync(
      git,
      [
        "clone",
        "--depth",
        "1",
        "https://github.com/searxng/searxng.git",
        sourceDir,
      ],
      { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } },
    );
  }

  if (!fs.existsSync(pythonBin)) {
    logInfo(logger, "web-search: creating searxng virtualenv");
    runCommandSync(python, ["-m", "venv", venvDir], {
      cwd: runtimeDir,
      env: { ...process.env, TMPDIR: tmpDir },
    });
  }

  logInfo(logger, "web-search: installing searxng runtime dependencies");
  runCommandSync(
    pipBin,
    ["install", "--upgrade", "pip", "wheel", "setuptools"],
    { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } },
  );
  runCommandSync(
    pipBin,
    ["install", "-r", path.join(sourceDir, "requirements.txt")],
    { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } },
  );
  runCommandSync(pipBin, ["install", "--no-build-isolation", "-e", sourceDir], {
    cwd: runtimeDir,
    env: { ...process.env, TMPDIR: tmpDir },
  });

  const nextState: RuntimeBootstrapState = {
    ready: true,
    sourceDir,
    pythonBin,
    pipBin,
    installedAt: new Date().toISOString(),
  };
  writeRuntimeBootstrapState(stateRoot, nextState);
  return { sourceDir, pythonBin, pipBin, reused: false };
}

function resolveWebSearchBaseUrl(): string {
  return trimString(process.env[RIN_WEB_SEARCH_BASE_URL_ENV]);
}

function createInstanceId(prefix = "ws"): string {
  const rand = crypto.randomBytes(6).toString("hex");
  return `${prefix}-${process.pid}-${rand}`;
}

async function ensureSearxngSidecar(
  stateRoot: string,
  options: EnsureSearxngSidecarOptions = {},
) {
  const logger = options.logger;
  const instanceId = trimString(options.instanceId) || createInstanceId("searxng");
  const existing = readNormalizedInstanceState(stateRoot, instanceId);
  if (existing.alive && existing.baseUrl) {
    process.env[RIN_WEB_SEARCH_BASE_URL_ENV] = existing.baseUrl;
    return {
      ok: true,
      instanceId,
      baseUrl: existing.baseUrl,
      reused: true,
    };
  }
  if (existing.pid > 0 || existing.baseUrl || existing.settingsPath) {
    removeStoredInstance(stateRoot, instanceId, existing.baseUrl);
  }

  const release = await acquireProcessLock(
    runtimeLockPathForState(stateRoot),
  ).catch((error: unknown) => {
    throw new Error(
      String(
        error instanceof Error
          ? error.message
          : error ||
              `web_search_lock_timeout:${runtimeLockPathForState(stateRoot)}`,
      ),
    );
  });

  let child: ChildProcess | null = null;
  let baseUrl = "";
  try {
    const runtime = ensureSearxngRuntimeInstalled(stateRoot, logger);
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const settingsPath = writeSearxngSettingsForInstance(
      stateRoot,
      instanceId,
      baseUrl,
      port,
    );
    const tmpDir = runtimeTmpDirForState(stateRoot);
    ensurePrivateDir(tmpDir);

    logInfo(
      logger,
      `web-search: starting searxng instance=${instanceId} baseUrl=${baseUrl}`,
    );
    child = spawn(runtime.pythonBin, ["-m", "searx.webapp"], {
      cwd: runtime.sourceDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        TMPDIR: tmpDir,
        PYTHONUNBUFFERED: "1",
        SEARXNG_SETTINGS_PATH: settingsPath,
        SEARXNG_PORT: String(port),
        SEARXNG_BIND_ADDRESS: "127.0.0.1",
        SEARXNG_BASE_URL: `${baseUrl}/`,
        SEARXNG_LIMITER: "false",
      },
    });
    try {
      child.unref();
    } catch {}

    const nextState: WebSearchInstanceState = {
      pid: toNumber(child.pid),
      port,
      baseUrl,
      pythonBin: runtime.pythonBin,
      sourceDir: runtime.sourceDir,
      settingsPath,
      startedAt: new Date().toISOString(),
      ownerPid: process.pid,
    };
    writeInstanceState(stateRoot, instanceId, nextState);

    const timeoutMs = Math.max(
      1,
      Number(options.timeoutMs ?? START_TIMEOUT_MS) || START_TIMEOUT_MS,
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isLivePid(child.pid)) {
        process.env[RIN_WEB_SEARCH_BASE_URL_ENV] = baseUrl;
        return {
          ok: true,
          instanceId,
          baseUrl,
          pid: toNumber(child.pid),
        };
      }
      await sleep(100);
    }

    throw new Error("searxng_start_timeout");
  } finally {
    try {
      release();
    } catch {}
    if (child && !isLivePid(child.pid)) {
      removeStoredInstance(stateRoot, instanceId, baseUrl);
    }
  }
}

async function stopSearxngSidecar(
  stateRoot: string,
  options: StopSearxngSidecarOptions = {},
) {
  const logger = options.logger;
  const instanceId = trimString(options.instanceId);
  if (!instanceId) return { ok: false, error: "web_search_instance_required" };

  const current = readNormalizedInstanceState(stateRoot, instanceId);
  if (current.alive) {
    try {
      process.kill(current.pid, "SIGTERM");
    } catch {}
  }
  removeStoredInstance(stateRoot, instanceId, current.baseUrl);
  logInfo(logger, `web-search: stopped searxng instance=${instanceId}`);
  return { ok: true, pid: current.pid };
}

async function cleanupOrphanSearxngSidecars(
  stateRoot: string,
  options: CleanupSearxngSidecarsOptions = {},
) {
  const logger = options.logger;
  const cleaned: Array<{ instanceId: string; pid: number; ownerPid?: number }> =
    [];
  for (const instanceId of listInstanceIds(stateRoot)) {
    const state = readNormalizedInstanceState(stateRoot, instanceId);
    if (!(state.ownerPid > 1)) continue;
    if (isPidAlive(state.ownerPid)) continue;
    if (state.alive) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {}
      await sleep(150);
    }
    removeStoredInstance(stateRoot, instanceId, state.baseUrl);
    cleaned.push({
      instanceId,
      pid: state.pid,
      ownerPid: state.ownerPid || undefined,
    });
    logInfo(
      logger,
      `web-search: cleaned orphan instance=${instanceId} pid=${state.pid} ownerPid=${state.ownerPid}`,
    );
  }
  return { ok: true, cleaned };
}

async function searchWeb({
  q,
  limit,
  domains,
  freshness,
  language,
}: WebSearchRequest): Promise<WebSearchResponse> {
  return await performWebSearch(resolveWebSearchBaseUrl(), {
    q,
    limit,
    domains,
    freshness,
    language,
  });
}

function getSearxngSidecarStatus(stateRoot: string) {
  const runtime = readRuntimeBootstrapState(stateRoot) || {};
  const instances = listInstanceIds(stateRoot).map((instanceId) => {
    const state = readNormalizedInstanceState(stateRoot, instanceId);
    return {
      instanceId,
      pid: state.pid,
      alive: state.alive,
      baseUrl: state.baseUrl,
      port: state.port,
      startedAt: state.startedAt,
      ownerPid: state.ownerPid || undefined,
      statePath: state.statePath,
      settingsPath: state.settingsPath,
    };
  });
  return {
    root: dataRootForState(stateRoot),
    runtime: {
      ready: Boolean(runtime?.ready),
      installedAt: trimString(runtime?.installedAt),
      pythonBin: trimString(runtime?.pythonBin),
      sourceDir: trimString(runtime?.sourceDir),
    },
    instances,
  };
}

export {
  RIN_WEB_SEARCH_BASE_URL_ENV,
  cleanupOrphanSearxngSidecars,
  ensureSearxngSidecar,
  getSearxngSidecarStatus,
  stopSearxngSidecar,
  searchWeb,
  type WebSearchRequest,
  type WebSearchResponse,
};
