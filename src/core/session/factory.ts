import fs from "node:fs/promises";
import path from "node:path";

import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import {
  createConfiguredAgentSession,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";

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
  const dirs = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const groups = await Promise.all([
    SessionManager.list(cwd, sessionDir).catch(() => []),
    ...dirs
      .filter((entry: any) => entry?.isDirectory?.())
      .map((entry: any) =>
        SessionManager.list(cwd, path.join(sessionDir, entry.name)).catch(
          () => [],
        ),
      ),
  ]);
  const seen = new Set<string>();
  return groups
    .flat()
    .filter((session: any) => {
      const sessionPath = String(session?.path || "").trim();
      if (!sessionPath) return false;
      const resolvedPath = path.resolve(sessionPath);
      if (seen.has(resolvedPath)) return false;
      seen.add(resolvedPath);
      return true;
    })
    .sort(
      (a: any, b: any) =>
        new Date(String(b?.modified || 0)).getTime() -
        new Date(String(a?.modified || 0)).getTime(),
    );
}
