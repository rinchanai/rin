import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import {
  createConfiguredAgentSession,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { normalizeBoundSessionList } from "./listing.js";

export async function openBoundSession(options: {
  cwd: string;
  agentDir: string;
  additionalExtensionPaths?: string[];
  sessionFile?: string;
  sessionManager?: any;
  thinkingLevel?: any;
}) {
  const { SessionManager } = await loadRinSessionManagerModule();
  const sessionDir = getRuntimeSessionDir(options.cwd, options.agentDir);
  const sessionManager =
    options.sessionManager ||
    (options.sessionFile
      ? SessionManager.open(options.sessionFile, sessionDir)
      : SessionManager.create(options.cwd, sessionDir));
  return await createConfiguredAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths ?? [],
    sessionManager,
    thinkingLevel: options.thinkingLevel,
  });
}

export async function listBoundSessions(options: {
  cwd?: string;
  agentDir?: string;
  sessionDir?: string;
  SessionManager?: any;
} = {}) {
  const { cwd, agentDir } = resolveRuntimeProfile(options);
  const sessionDir = options.sessionDir || getRuntimeSessionDir(cwd, agentDir);
  const { SessionManager } = options.SessionManager
    ? { SessionManager: options.SessionManager }
    : await loadRinSessionManagerModule();
  const sessions = await SessionManager.list(cwd, sessionDir).catch(() => []);
  return normalizeBoundSessionList(sessions);
}

export async function renameBoundSession(
  sessionPath: string,
  name: string,
  options: { SessionManager?: any } = {},
) {
  const nextName = String(name || "").trim();
  if (!nextName) throw new Error("Session name cannot be empty");
  const { SessionManager } = options.SessionManager
    ? { SessionManager: options.SessionManager }
    : await loadRinSessionManagerModule();
  const manager = SessionManager.open(sessionPath);
  manager.appendSessionInfo(nextName);
}
