import { hasSessionRef, normalizeSessionRef, resolveSessionRef, sessionRefMatches, } from "../session/ref.js";
export function normalizeSessionSelector(value) {
    return normalizeSessionRef(value);
}
export function sessionSelectorFromCommand(command) {
    return normalizeSessionRef(command);
}
export function sessionSelectorFromState(value) {
    return normalizeSessionRef(value);
}
export function hasSessionSelector(selector) {
    return hasSessionRef(selector);
}
export function resolveSessionSelector(commandSelector, fallbackSelector) {
    return resolveSessionRef(commandSelector, fallbackSelector);
}
export function sessionMatchesSelector(current, selector) {
    return sessionRefMatches(current, selector);
}
