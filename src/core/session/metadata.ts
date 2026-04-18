import {
  normalizeSessionRef,
  normalizeSessionValue,
} from "./ref.js";

export { normalizeSessionRef, normalizeSessionValue } from "./ref.js";

export type SessionMetadata = {
  sessionId: string;
  sessionFile: string;
  leafId: string;
  sessionName: string;
  cwd: string;
  sessionPersisted: boolean;
};

type SessionManagerLike = {
  getSessionId?: () => unknown;
  getSessionFile?: () => unknown;
  getLeafId?: () => unknown;
  getSessionName?: () => unknown;
  getCwd?: () => unknown;
  isPersisted?: () => unknown;
};

type SessionSourceLike = {
  sessionManager?: SessionManagerLike;
  sessionId?: unknown;
  sessionFile?: unknown;
  leafId?: unknown;
  sessionName?: unknown;
  cwd?: unknown;
  sessionPersisted?: unknown;
};

export function readSessionMetadata(
  source: SessionSourceLike | SessionManagerLike | null | undefined,
): SessionMetadata {
  const sessionSource = (source as SessionSourceLike | null | undefined) || undefined;
  const sessionManager = (sessionSource?.sessionManager || source || undefined) as
    | SessionManagerLike
    | undefined;
  const { sessionId, sessionFile } = normalizeSessionRef({
    sessionId: sessionSource?.sessionId ?? sessionManager?.getSessionId?.(),
    sessionFile: sessionSource?.sessionFile ?? sessionManager?.getSessionFile?.(),
  });

  return {
    sessionId: sessionId || "",
    sessionFile: sessionFile || "",
    leafId:
      normalizeSessionValue(
        sessionSource?.leafId ?? sessionManager?.getLeafId?.(),
      ) || "",
    sessionName:
      normalizeSessionValue(
        sessionSource?.sessionName ?? sessionManager?.getSessionName?.(),
      ) || "",
    cwd:
      normalizeSessionValue(
        sessionSource?.cwd ?? sessionManager?.getCwd?.() ?? process.cwd(),
      ) || "",
    sessionPersisted: Boolean(
      (sessionSource?.sessionPersisted ?? sessionManager?.isPersisted?.()) &&
        sessionFile,
    ),
  };
}

export function readSessionIdentity(source: SessionSourceLike | SessionManagerLike | null | undefined) {
  const metadata = readSessionMetadata(source);
  return metadata.sessionFile || metadata.sessionId || metadata.cwd || "unknown-session";
}
