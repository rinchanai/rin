import { normalizeSessionValue } from "../session/metadata.js";
export function normalizeSessionSelector(value) {
    return {
        sessionFile: normalizeSessionValue(value?.sessionFile ?? value?.sessionPath),
        sessionId: normalizeSessionValue(value?.sessionId),
    };
}
export function sessionSelectorFromCommand(command) {
    return normalizeSessionSelector(command);
}
export function sessionSelectorFromState(value) {
    return normalizeSessionSelector(value);
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
