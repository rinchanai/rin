import fs from "node:fs";
import path from "node:path";

import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import {
  createConfiguredAgentSession,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { safeString } from "../text-utils.js";
import { normalizeBoundSessionList } from "./listing.js";
import {
  requireSessionFile,
  readSessionFile,
  type SessionFileInput,
} from "./ref.js";

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
  const sessionFile = readSessionFile(options.sessionFile);
  const sessionManager =
    options.sessionManager ||
    (sessionFile
      ? SessionManager.open(sessionFile)
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

export async function resolveBoundSessionReference(
  ref: string,
  options: {
    cwd?: string;
    agentDir?: string;
    sessionDir?: string;
    SessionManager?: any;
  } = {},
): Promise<{ path: string; id?: string }> {
  const wanted = safeString(ref).trim();
  if (!wanted) throw new Error("session_ref_required");

  const { cwd, agentDir } = resolveRuntimeProfile(options);
  const sessionDir = options.sessionDir || getRuntimeSessionDir(cwd, agentDir);
  const normalizedWanted = wanted.toLowerCase();
  const directCandidates = path.isAbsolute(wanted)
    ? [wanted]
    : [path.resolve(cwd, wanted)];
  const directMatchPath = directCandidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  const normalizedDirectPath = directMatchPath
    ? path.resolve(directMatchPath).toLowerCase()
    : undefined;
  const sessions = await listBoundSessions({
    cwd,
    agentDir,
    sessionDir,
    SessionManager: options.SessionManager,
  });

  const findResult = (predicate: (session: any) => boolean) =>
    sessions.find(predicate);
  const exactPath = findResult(
    (info: any) =>
      normalizedDirectPath &&
      path.resolve(String(info?.path || "")).toLowerCase() === normalizedDirectPath,
  );
  if (exactPath) {
    return {
      path: String(exactPath.path || ""),
      id: safeString(exactPath.id).trim() || undefined,
    };
  }

  const exactId = findResult(
    (info: any) => String(info?.id || "").toLowerCase() === normalizedWanted,
  );
  if (exactId) {
    return {
      path: String(exactId.path || ""),
      id: safeString(exactId.id).trim() || undefined,
    };
  }

  const exactPathText = findResult(
    (info: any) => path.resolve(String(info?.path || "")).toLowerCase() === normalizedWanted,
  );
  if (exactPathText) {
    return {
      path: String(exactPathText.path || ""),
      id: safeString(exactPathText.id).trim() || undefined,
    };
  }

  const prefixMatches = sessions.filter((info: any) =>
    String(info?.id || "").toLowerCase().startsWith(normalizedWanted),
  );
  if (prefixMatches.length === 1) {
    return {
      path: String(prefixMatches[0]?.path || ""),
      id: safeString(prefixMatches[0]?.id).trim() || undefined,
    };
  }
  if (prefixMatches.length > 1) {
    throw new Error(
      `Session ref is ambiguous: ${wanted}. Inspect ${sessionDir} and use an exact path or a less ambiguous id prefix.`,
    );
  }

  throw new Error(
    `Session not found: ${wanted}. Inspect ${sessionDir} and use a session file path, exact id, or unique id prefix.`,
  );
}

export async function renameBoundSession(
  session: SessionFileInput,
  name: string,
  options: { SessionManager?: any } = {},
) {
  const sessionFile = requireSessionFile(session);
  const nextName = String(name || "").trim();
  if (!nextName) throw new Error("Session name cannot be empty");
  const { SessionManager } = options.SessionManager
    ? { SessionManager: options.SessionManager }
    : await loadRinSessionManagerModule();
  const manager = SessionManager.open(sessionFile);
  manager.appendSessionInfo(nextName);
}
