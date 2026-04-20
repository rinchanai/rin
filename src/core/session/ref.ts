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

export type SessionFileInput = string | SessionRefInput;

export function normalizeSessionValue(value: unknown) {
  const text = safeString(value).trim();
  return text || undefined;
}

export function resolveSessionValue(primary: unknown, fallback?: unknown) {
  return normalizeSessionValue(primary) ?? normalizeSessionValue(fallback);
}

export function normalizeSessionRef(
  value: SessionRefInput | null | undefined,
): SessionRef {
  return {
    sessionId: normalizeSessionValue(value?.sessionId),
    sessionFile: resolveSessionValue(value?.sessionFile, value?.sessionPath),
  };
}

export function hasSessionRef(value: SessionRefInput | null | undefined) {
  const ref = normalizeSessionRef(value);
  return Boolean(ref.sessionFile || ref.sessionId);
}

export function readSessionFile(
  value: SessionFileInput | null | undefined,
): string | undefined {
  if (typeof value === "string") return normalizeSessionValue(value);
  return normalizeSessionRef(value).sessionFile;
}

export function requireSessionFile(
  value: SessionFileInput | null | undefined,
  error = "Session file is required",
): string {
  const sessionFile = readSessionFile(value);
  if (sessionFile) return sessionFile;
  throw new Error(error);
}

export function resolveSessionRef(
  primary: SessionRefInput | null | undefined,
  fallback: SessionRefInput | null | undefined,
): SessionRef {
  const primaryRef = normalizeSessionRef(primary);
  const fallbackRef = normalizeSessionRef(fallback);
  return {
    sessionId: primaryRef.sessionId ?? fallbackRef.sessionId,
    sessionFile: primaryRef.sessionFile ?? fallbackRef.sessionFile,
  };
}

export function sessionRefMatches(
  current: SessionRefInput | null | undefined,
  selector: SessionRefInput | null | undefined,
) {
  const currentRef = normalizeSessionRef(current);
  const selectorRef = normalizeSessionRef(selector);
  if (!hasSessionRef(selectorRef)) return false;
  if (
    selectorRef.sessionFile &&
    currentRef.sessionFile !== selectorRef.sessionFile
  ) {
    return false;
  }
  if (selectorRef.sessionId && currentRef.sessionId !== selectorRef.sessionId) {
    return false;
  }
  return true;
}
