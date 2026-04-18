import {
  hasSessionRef,
  normalizeSessionRef,
  resolveSessionRef,
  sessionRefMatches,
  type SessionRef,
  type SessionRefInput,
} from "../session/ref.js";

export type SessionSelector = SessionRef;

type SessionSelectorInput = SessionRefInput;

export function normalizeSessionSelector(
  value: SessionSelectorInput | null | undefined,
): SessionSelector {
  return normalizeSessionRef(value);
}

export function sessionSelectorFromCommand(command: any): SessionSelector {
  return normalizeSessionRef(command);
}

export function sessionSelectorFromState(
  value:
    | {
        sessionFile?: unknown;
        sessionId?: unknown;
      }
    | null
    | undefined,
): SessionSelector {
  return normalizeSessionRef(value);
}

export function hasSessionSelector(selector: SessionSelector) {
  return hasSessionRef(selector);
}

export function resolveSessionSelector(
  commandSelector: SessionSelector,
  fallbackSelector: SessionSelector,
) {
  return resolveSessionRef(commandSelector, fallbackSelector);
}

export function sessionMatchesSelector(
  current: SessionSelector,
  selector: SessionSelector,
) {
  return sessionRefMatches(current, selector);
}
