import { randomUUID } from "node:crypto";

type ForkCapabilities = {
  legacy: boolean;
  optionAware: boolean;
};

function normalizeLeafId(value: unknown) {
  const leafId = String(value || "").trim();
  return leafId || undefined;
}

function normalizeForkOptions(
  options: { persist?: boolean; leafId?: string } = {},
) {
  return {
    ...options,
    leafId: normalizeLeafId(options.leafId),
    persist: options.persist !== false,
  };
}

function getForkCapabilities(SessionManager: any): ForkCapabilities {
  const legacy = typeof SessionManager?.forkFrom === "function";
  return {
    legacy,
    optionAware: legacy && SessionManager.forkFrom.length >= 4,
  };
}

function resolveForkEntries(sourceManager: any, leafId?: string) {
  const branchEntries = leafId ? sourceManager.getBranch?.(leafId) : undefined;
  if (Array.isArray(branchEntries) && branchEntries.length > 0) {
    return branchEntries;
  }
  const entries = sourceManager.getEntries?.();
  return Array.isArray(entries) ? entries : [];
}

function createEphemeralForkManager(
  SessionManager: any,
  sourcePath: string,
  targetCwd: string,
  sessionDir: string | undefined,
  leafId: string | undefined,
) {
  if (
    typeof SessionManager?.open !== "function" ||
    typeof SessionManager !== "function"
  ) {
    throw new Error("session_fork_unsupported:ephemeral");
  }

  const sourceManager = SessionManager.open(sourcePath, sessionDir, undefined);
  const sourceHeader = sourceManager.getHeader?.() || {};
  const manager = new SessionManager(
    targetCwd,
    sessionDir || "",
    undefined,
    false,
  );
  manager.fileEntries = [
    {
      ...sourceHeader,
      type: "session",
      version: Number(sourceHeader?.version || 3),
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: targetCwd,
      parentSession: sourcePath,
    },
    ...resolveForkEntries(sourceManager, leafId),
  ];
  manager.sessionId = manager.fileEntries[0].id;
  manager.sessionFile = undefined;
  manager.flushed = false;
  manager._buildIndex?.();
  return manager;
}

export function forkSessionManagerCompat(
  SessionManager: any,
  sourcePath: string,
  targetCwd: string,
  sessionDir?: string,
  options: { persist?: boolean; leafId?: string } = {},
) {
  const normalizedOptions = normalizeForkOptions(options);
  const capabilities = getForkCapabilities(SessionManager);

  if (capabilities.optionAware) {
    return SessionManager.forkFrom(
      sourcePath,
      targetCwd,
      sessionDir,
      normalizedOptions,
    );
  }

  if (normalizedOptions.persist) {
    if (!capabilities.legacy) {
      throw new Error("session_fork_unsupported:persisted");
    }
    return SessionManager.forkFrom(sourcePath, targetCwd, sessionDir);
  }

  return createEphemeralForkManager(
    SessionManager,
    sourcePath,
    targetCwd,
    sessionDir,
    normalizedOptions.leafId,
  );
}
