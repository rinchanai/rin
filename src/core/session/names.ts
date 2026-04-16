import fs from "node:fs";
import path from "node:path";

import {
  listChatStateFiles,
  listDetachedControllerStateFiles,
  parseChatKey,
  readJsonFile,
} from "../chat/support.js";

function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

export const CHAT_SESSION_NAME_SEPARATOR = " — ";
const DEFAULT_SESSION_NAME_DETAIL_MAX = 180;

export function normalizeSessionNameDetail(
  value: unknown,
  max = DEFAULT_SESSION_NAME_DETAIL_MAX,
): string {
  const text = safeString(value)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function formatChatSessionName(chatKey: string, detail?: string): string {
  const normalizedChatKey = safeString(chatKey).trim();
  const normalizedDetail = normalizeSessionNameDetail(detail);
  if (!normalizedChatKey) return normalizedDetail;
  if (!normalizedDetail) return normalizedChatKey;
  return `${normalizedChatKey}${CHAT_SESSION_NAME_SEPARATOR}${normalizedDetail}`;
}

export function extractChatKeyFromSessionName(name: string): string | undefined {
  const normalized = safeString(name).trim();
  if (!normalized) return undefined;
  if (parseChatKey(normalized)) return normalized;
  const separatorIndex = normalized.indexOf(CHAT_SESSION_NAME_SEPARATOR);
  if (separatorIndex < 0) return undefined;
  const prefix = normalized.slice(0, separatorIndex).trim();
  if (!prefix) return undefined;
  return parseChatKey(prefix) ? prefix : undefined;
}

export function readFirstUserMessageFromSessionFile(sessionFile: string): string {
  const filePath = path.resolve(safeString(sessionFile).trim());
  if (!filePath || !fs.existsSync(filePath)) return "";
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = JSON.parse(trimmed) as any;
      if (entry?.type !== "message") continue;
      const message = entry?.message;
      if (safeString(message?.role).trim() !== "user") continue;
      const content = message?.content;
      if (typeof content === "string") {
        const text = normalizeSessionNameDetail(content, 120);
        if (text) return text;
        continue;
      }
      if (!Array.isArray(content)) continue;
      const text = normalizeSessionNameDetail(
        content
          .filter((part) => part && typeof part === "object" && part.type === "text")
          .map((part) => safeString((part as any).text))
          .join(" "),
        120,
      );
      if (text) return text;
    }
  } catch {}
  return "";
}

export function findChatKeyBySessionFile(
  agentDir: string,
  sessionFile: string,
): string | undefined {
  const resolvedAgentDir = path.resolve(safeString(agentDir).trim());
  const resolvedSessionFile = path.resolve(safeString(sessionFile).trim());
  if (!resolvedAgentDir || !resolvedSessionFile) return undefined;

  const candidates = [
    ...listChatStateFiles(path.join(resolvedAgentDir, "data", "chat-state")),
    ...listDetachedControllerStateFiles(
      path.join(resolvedAgentDir, "data", "cron-turns"),
    ).map((item) => ({ chatKey: item.chatKey, statePath: item.statePath })),
  ];

  for (const candidate of candidates) {
    try {
      const state = readJsonFile<any>(candidate.statePath, {});
      const currentSessionFile = path.resolve(
        safeString(state?.piSessionFile || "").trim(),
      );
      if (currentSessionFile && currentSessionFile === resolvedSessionFile) {
        const chatKey = safeString(candidate.chatKey).trim();
        if (parseChatKey(chatKey)) return chatKey;
      }
    } catch {}
  }

  return undefined;
}
