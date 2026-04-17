import { randomUUID } from "node:crypto";

export function forkSessionManagerCompat(
  SessionManager: any,
  sourcePath: string,
  targetCwd: string,
  sessionDir?: string,
  options: { persist?: boolean; leafId?: string } = {},
) {
  if (
    typeof SessionManager?.forkFrom === "function" &&
    SessionManager.forkFrom.length >= 4
  ) {
    return SessionManager.forkFrom(sourcePath, targetCwd, sessionDir, options);
  }
  if (options.persist !== false) {
    return SessionManager.forkFrom(sourcePath, targetCwd, sessionDir);
  }

  const sourceManager = SessionManager.open(sourcePath, sessionDir, undefined);
  const sourceHeader = sourceManager.getHeader?.() || {};
  const forkEntries = options.leafId
    ? sourceManager.getBranch(options.leafId)
    : sourceManager.getEntries();
  const manager = new SessionManager(targetCwd, sessionDir || "", undefined, false);
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
    ...forkEntries,
  ];
  manager.sessionId = manager.fileEntries[0].id;
  manager.sessionFile = undefined;
  manager.flushed = false;
  manager._buildIndex?.();
  return manager;
}
