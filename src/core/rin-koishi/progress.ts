import { safeString } from "./chat-helpers.js";

const DEFAULT_PRIVATE_IDLE_TOOL_PROGRESS_INTERVAL_MS = 60_000;
const DEFAULT_GROUP_IDLE_TOOL_PROGRESS_INTERVAL_MS = 60_000;
const DEFAULT_TOOL_INPUT_PREVIEW_CHARS = 160;

export type KoishiIdleToolProgressConfig = {
  privateIntervalMs: number;
  groupIntervalMs: number;
};

function normalizeIntervalMs(value: unknown, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.max(1000, Math.floor(next));
}

function shortenPreview(
  value: unknown,
  maxChars = DEFAULT_TOOL_INPUT_PREVIEW_CHARS,
) {
  const text = safeString(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function summarizeGenericArgs(args: any) {
  if (args == null) return "";
  if (typeof args === "string") return shortenPreview(args);
  if (Array.isArray(args))
    return `${args.length} item${args.length === 1 ? "" : "s"}`;
  if (typeof args !== "object") return shortenPreview(String(args));
  const preferredKeys = [
    "path",
    "file_path",
    "command",
    "url",
    "q",
    "query",
    "text",
    "messageId",
    "chatKey",
    "date",
    "slot",
    "name",
    "expression",
    "runAt",
  ];
  const ignoredKeys = new Set([
    "content",
    "oldText",
    "newText",
    "edits",
    "parts",
    "data",
    "images",
    "attachments",
    "baseContent",
    "prompt",
    "command",
    "text",
  ]);
  const parts: string[] = [];
  for (const key of preferredKeys) {
    const value = (args as any)?.[key];
    if (value == null) continue;
    const preview = shortenPreview(
      value,
      key === "command" || key === "text" ? 120 : 80,
    );
    if (!preview) continue;
    parts.push(
      key === "path" ||
        key === "file_path" ||
        key === "command" ||
        key === "url" ||
        key === "q" ||
        key === "query" ||
        key === "text"
        ? preview
        : `${key}=${preview}`,
    );
  }
  if (parts.length) return parts.join(", ");
  for (const [key, value] of Object.entries(args)) {
    if (ignoredKeys.has(key)) continue;
    if (value == null) continue;
    const preview = shortenPreview(
      typeof value === "object"
        ? Array.isArray(value)
          ? `${value.length} item${value.length === 1 ? "" : "s"}`
          : JSON.stringify(value)
        : value,
      60,
    );
    if (!preview) continue;
    parts.push(`${key}=${preview}`);
    if (parts.length >= 3) break;
  }
  return parts.join(", ");
}

export function extractFinalTextFromTurnResult(result: any) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (safeString((message as any).type).trim() !== "text") continue;
    const text = safeString((message as any).text).trim();
    if (text) return text;
  }
  return "";
}

export function summarizeKoishiToolCall(toolName: string, args: any) {
  const name = safeString(toolName).trim() || "tool";
  if (name === "bash") {
    const command = shortenPreview(args?.command, 120);
    return command ? `bash ${command}` : "bash";
  }
  if (name === "read") {
    const target = shortenPreview(args?.path ?? args?.file_path, 100);
    const offset = Number.isFinite(Number(args?.offset))
      ? Number(args.offset)
      : undefined;
    const limit = Number.isFinite(Number(args?.limit))
      ? Number(args.limit)
      : undefined;
    const range =
      offset !== undefined || limit !== undefined
        ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
        : "";
    return target ? `read ${target}${range}` : "read";
  }
  if (name === "edit") {
    const target = shortenPreview(args?.path ?? args?.file_path, 100);
    const editCount = Array.isArray(args?.edits) ? args.edits.length : 0;
    const suffix =
      editCount > 0 ? ` (${editCount} edit${editCount === 1 ? "" : "s"})` : "";
    return target ? `edit ${target}${suffix}` : `edit${suffix}`;
  }
  if (name === "write") {
    const target = shortenPreview(args?.path ?? args?.file_path, 100);
    return target ? `write ${target}` : "write";
  }
  const summary = summarizeGenericArgs(args);
  return summary ? `${name} ${summary}` : name;
}

export function normalizeKoishiIdleToolProgressConfig(
  settings: any,
): KoishiIdleToolProgressConfig {
  const koishi =
    settings && typeof settings.koishi === "object" ? settings.koishi : {};
  const idleToolProgress =
    koishi && typeof koishi.idleToolProgress === "object"
      ? koishi.idleToolProgress
      : {};
  return {
    privateIntervalMs: normalizeIntervalMs(
      idleToolProgress?.privateIntervalMs,
      DEFAULT_PRIVATE_IDLE_TOOL_PROGRESS_INTERVAL_MS,
    ),
    groupIntervalMs: normalizeIntervalMs(
      idleToolProgress?.groupIntervalMs,
      DEFAULT_GROUP_IDLE_TOOL_PROGRESS_INTERVAL_MS,
    ),
  };
}
