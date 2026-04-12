import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getBuiltinExtensionPaths } from "../../app/builtin-extensions.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
import {
  createConfiguredAgentSession,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import type {
  SubagentSessionConfig,
  SubagentSessionMode,
  SubagentTask,
} from "./types.js";

const HOME_DIR = os.homedir();

let sessionCreationQueue: Promise<unknown> = Promise.resolve();

function withSessionCreationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sessionCreationQueue.then(fn, fn);
  sessionCreationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function getSubagentExtensionPaths(): string[] {
  return getBuiltinExtensionPaths().filter((entry) => {
    const normalized = entry.split(path.sep).join("/");
    return (
      !normalized.endsWith("/extensions/subagent/index.ts") &&
      !normalized.endsWith("/extensions/subagent/index.js")
    );
  });
}

export function normalizeSessionConfig(
  session: SubagentSessionConfig | undefined,
): Required<Pick<SubagentSessionConfig, "mode">> & SubagentSessionConfig {
  const mode = (session?.mode || "memory") as SubagentSessionMode;
  return {
    mode,
    ref: String(session?.ref || "").trim() || undefined,
    name: String(session?.name || "").trim() || undefined,
  };
}

export function isPersistedMode(mode: SubagentSessionMode): boolean {
  return mode !== "memory";
}

async function loadSessionManagerModule() {
  const codingAgentModule = await loadRinCodingAgent();
  return { SessionManager: (codingAgentModule as any).SessionManager };
}

export async function resolveSessionReference(
  ref: string,
): Promise<{ path: string }> {
  const wanted = String(ref || "").trim();
  if (!wanted) throw new Error("session_ref_required");

  const directCandidates = path.isAbsolute(wanted)
    ? [wanted]
    : [path.resolve(HOME_DIR, wanted)];
  const directMatchPath = directCandidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  const { SessionManager } = await loadSessionManagerModule();
  const sessions = await SessionManager.listAll();
  const normalizedWanted = wanted.toLowerCase();
  const normalizedDirectPath = directMatchPath
    ? path.resolve(directMatchPath).toLowerCase()
    : undefined;

  const exactPath = sessions.find(
    (info: any) =>
      normalizedDirectPath &&
      path.resolve(String(info?.path || "")).toLowerCase() ===
        normalizedDirectPath,
  );
  if (exactPath) return { path: String(exactPath.path || "") };

  const exactId = sessions.find(
    (info: any) => String(info?.id || "").toLowerCase() === normalizedWanted,
  );
  if (exactId) return { path: String(exactId.path || "") };

  const exactPathText = sessions.find(
    (info: any) =>
      path.resolve(String(info?.path || "")).toLowerCase() === normalizedWanted,
  );
  if (exactPathText) return { path: String(exactPathText.path || "") };

  const prefixMatches = sessions.filter((info: any) =>
    String(info?.id || "")
      .toLowerCase()
      .startsWith(normalizedWanted),
  );
  if (prefixMatches.length === 1) {
    return { path: String(prefixMatches[0]?.path || "") };
  }
  if (prefixMatches.length > 1) {
    throw new Error(
      `Session ref is ambiguous: ${wanted}. Inspect ${path.join(os.homedir(), ".rin", "sessions")} and use an exact path or a less ambiguous id prefix.`,
    );
  }

  throw new Error(
    `Session not found: ${wanted}. Inspect ${path.join(os.homedir(), ".rin", "sessions")} and use a session file path, exact id, or unique id prefix.`,
  );
}

export async function createManagedSession(task: SubagentTask) {
  const cwd = HOME_DIR;
  const sessionConfig = normalizeSessionConfig(task.session);
  const profile = resolveRuntimeProfile({ cwd });
  const sessionDir = getRuntimeSessionDir(cwd, profile.agentDir);
  const { SessionManager } = await loadSessionManagerModule();

  let sessionManager: any;
  if (sessionConfig.mode === "memory") {
    sessionManager = SessionManager.inMemory(cwd);
  } else if (sessionConfig.mode === "persist") {
    sessionManager = SessionManager.create(cwd, sessionDir);
  } else if (sessionConfig.mode === "resume") {
    const source = await resolveSessionReference(sessionConfig.ref || "");
    sessionManager = SessionManager.open(source.path, sessionDir, undefined);
  } else {
    const source = await resolveSessionReference(sessionConfig.ref || "");
    sessionManager = SessionManager.forkFrom(source.path, cwd, sessionDir);
  }

  const created = await withSessionCreationLock(async () => {
    return await createConfiguredAgentSession({
      cwd: sessionManager.getCwd?.() || cwd,
      agentDir: profile.agentDir,
      additionalExtensionPaths: getSubagentExtensionPaths(),
      sessionManager,
      modelRef: task.model,
      thinkingLevel: task.thinkingLevel,
    });
  });

  if (sessionConfig.name) {
    created.session.setSessionName(sessionConfig.name);
  }

  return {
    ...created,
    sessionConfig,
  };
}
