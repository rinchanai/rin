import { normalizeStringList } from "../text-utils.js";

const BUILTIN_MODULES = [
  ["rules", "../rules/index.js"],
  ["web-search", "../rin-web-search/index.js"],
  ["fetch", "../fetch/index.js"],
  ["memory", "../memory/index.js"],
  ["self-improve", "../self-improve/index.js"],
  ["message-header", "../chat-bridge/message-header.js"],
  ["auto-compact-continue", "../rin-lib/auto-compact-continue.js"],
  ["tui-input-compat", "../rin-tui/input-compat.js"],
  ["subagent", "../subagent/index.js"],
  ["task", "../task/index.js"],
  ["chat", "../chat/index.js"],
  ["token-usage", "../token-usage/index.js"],
] as const;

export const BUILTIN_MODULE_ORDER = BUILTIN_MODULES.map(
  ([name]) => name,
) as BuiltinModuleName[];

export type BuiltinModuleName = (typeof BUILTIN_MODULES)[number][0];

const BUILTIN_MODULE_PATHS = Object.fromEntries(BUILTIN_MODULES) as Record<
  BuiltinModuleName,
  string
>;

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
