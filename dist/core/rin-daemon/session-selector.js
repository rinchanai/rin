import { normalizeSessionValue } from "../session/metadata.js";
export function sessionSelectorFromCommand(command) {
    return {
        sessionFile: normalizeSessionValue(command?.sessionFile ?? command?.sessionPath),
        sessionId: normalizeSessionValue(command?.sessionId),
    };
}
export function sessionSelectorFromState(value) {
    return {
        sessionFile: normalizeSessionValue(value?.sessionFile),
        sessionId: normalizeSessionValue(value?.sessionId),
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
