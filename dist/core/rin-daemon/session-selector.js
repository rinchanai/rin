function normalizeSelectorValue(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return text || undefined;
}
export function sessionSelectorFromCommand(command) {
    return {
        sessionFile: normalizeSelectorValue(command?.sessionFile ?? command?.sessionPath),
        sessionId: normalizeSelectorValue(command?.sessionId),
    };
}
export function sessionSelectorFromState(value) {
    return {
        sessionFile: normalizeSelectorValue(value?.sessionFile),
        sessionId: normalizeSelectorValue(value?.sessionId),
    };
}
export function hasSessionSelector(selector) {
    return Boolean(selector.sessionFile || selector.sessionId);
}
export function resolveSessionSelector(commandSelector, fallbackSelector) {
    return hasSessionSelector(commandSelector)
        ? commandSelector
        : fallbackSelector;
}
export function sessionMatchesSelector(current, selector) {
    if (selector.sessionFile && current.sessionFile === selector.sessionFile) {
        return true;
    }
    if (selector.sessionId && current.sessionId === selector.sessionId) {
        return true;
    }
    return false;
}
