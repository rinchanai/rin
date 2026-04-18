export type SessionSelector = {
  sessionFile?: string;
  sessionId?: string;
};

function normalizeSelectorValue(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

export function sessionSelectorFromCommand(command: any): SessionSelector {
  return {
    sessionFile: normalizeSelectorValue(
      command?.sessionFile ?? command?.sessionPath,
    ),
    sessionId: normalizeSelectorValue(command?.sessionId),
  };
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
  return {
    sessionFile: normalizeSelectorValue(value?.sessionFile),
    sessionId: normalizeSelectorValue(value?.sessionId),
  };
}

export function hasSessionSelector(selector: SessionSelector) {
  return Boolean(selector.sessionFile || selector.sessionId);
}

export function resolveSessionSelector(
  commandSelector: SessionSelector,
  fallbackSelector: SessionSelector,
) {
  return hasSessionSelector(commandSelector)
    ? commandSelector
    : fallbackSelector;
}

export function sessionMatchesSelector(
  current: SessionSelector,
  selector: SessionSelector,
) {
  if (selector.sessionFile && current.sessionFile === selector.sessionFile) {
    return true;
  }
  if (selector.sessionId && current.sessionId === selector.sessionId) {
    return true;
  }
  return false;
}
