import { safeString } from "../text-utils.js";

export type SessionRef = {
  sessionId?: string;
  sessionFile?: string;
};

export type SessionRefInput = {
  sessionId?: unknown;
  sessionFile?: unknown;
  sessionPath?: unknown;
};

export function normalizeSessionValue(value: unknown) {
  const text = safeString(value).trim();
  return text || undefined;
}

export function normalizeSessionRef(
  value: SessionRefInput | null | undefined,
): SessionRef {
  return {
    sessionId: normalizeSessionValue(value?.sessionId),
    sessionFile: normalizeSessionValue(value?.sessionFile ?? value?.sessionPath),
  };
}

export function hasSessionRef(value: SessionRef | null | undefined) {
  return Boolean(value?.sessionFile || value?.sessionId);
}

export function resolveSessionRef(primary: SessionRef, fallback: SessionRef) {
  return hasSessionRef(primary) ? primary : fallback;
}

export function sessionRefMatches(current: SessionRef, selector: SessionRef) {
  if (selector.sessionFile && current.sessionFile === selector.sessionFile) {
    return true;
  }
  if (selector.sessionId && current.sessionId === selector.sessionId) {
    return true;
  }
  return false;
}
