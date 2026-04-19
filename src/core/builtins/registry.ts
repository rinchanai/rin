import { normalizeStringList } from "../text-utils.js";

export const BUILTIN_MODULE_ORDER = [
  "rules",
  "web-search",
  "fetch",
  "memory",
  "self-improve",
  "reset-system-prompt",
  "message-header",
  "freeze-session-runtime",
  "auto-compact-continue",
  "tui-input-compat",
  "subagent",
  "task",
  "chat",
  "token-usage",
] as const;

export type BuiltinModuleName =
  (typeof BUILTIN_MODULE_ORDER)[number];

const BUILTIN_MODULE_PATHS: Record<BuiltinModuleName, string> = {
  rules: "../rules/index.js",
  "web-search": "../rin-web-search/index.js",
  fetch: "../fetch/index.js",
  memory: "../memory/index.js",
  "self-improve": "../self-improve/index.js",
  "reset-system-prompt": "../rin-lib/reset-system-prompt.js",
  "message-header": "../chat-bridge/message-header.js",
  "freeze-session-runtime": "../rin-lib/freeze-session-runtime.js",
  "auto-compact-continue": "../rin-lib/auto-compact-continue.js",
  "tui-input-compat": "../rin-tui/input-compat.js",
  subagent: "../subagent/index.js",
  task: "../task/index.js",
  chat: "../chat/index.js",
  "token-usage": "../token-usage/index.js",
};

export function normalizeBuiltinModuleNames(values: unknown): string[] {
  return Array.isArray(values)
    ? normalizeStringList(values, { lowercase: true })
    : [];
}

export function getBuiltinModuleNames(
  disabledNames: unknown = [],
): BuiltinModuleName[] {
  const blocked = new Set(normalizeBuiltinModuleNames(disabledNames));
  return BUILTIN_MODULE_ORDER.filter((name) => !blocked.has(name));
}

export function getBuiltinModuleUrl(name: BuiltinModuleName): URL {
  return new URL(BUILTIN_MODULE_PATHS[name], import.meta.url);
}
