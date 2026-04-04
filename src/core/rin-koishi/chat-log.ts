import fs from "node:fs";
import path from "node:path";

import { parseChatKey } from "./support.js";

export type KoishiChatLogEntry = {
  version: 1;
  timestamp: string;
  chatKey: string;
  role: "user" | "assistant";
  text: string;
  messageId?: string;
  replyToMessageId?: string;
  sessionId?: string;
  sessionFile?: string;
  userId?: string;
  nickname?: string;
};

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function koishiChatLogDir(agentDir: string) {
  return path.join(path.resolve(agentDir), "data", "koishi-chat-logs");
}

function normalizeDateParts(value: string) {
  const text = safeString(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return { year: match[1], month: match[2], day: match[3] };
  const date = text ? new Date(text) : new Date();
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return {
      year: String(now.getUTCFullYear()),
      month: String(now.getUTCMonth() + 1).padStart(2, "0"),
      day: String(now.getUTCDate()).padStart(2, "0"),
    };
  }
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    day: String(date.getUTCDate()).padStart(2, "0"),
  };
}

export function koishiChatLogPath(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const { year, month, day } = normalizeDateParts(date);
  return parsed.botId
    ? path.join(
        koishiChatLogDir(agentDir),
        parsed.platform,
        parsed.botId,
        parsed.chatId,
        year,
        month,
        `${day}.jsonl`,
      )
    : path.join(
        koishiChatLogDir(agentDir),
        parsed.platform,
        parsed.chatId,
        year,
        month,
        `${day}.jsonl`,
      );
}

export function appendKoishiChatLog(
  agentDir: string,
  input: Omit<KoishiChatLogEntry, "version">,
) {
  const chatKey = safeString(input.chatKey).trim();
  const text = safeString(input.text).trim();
  const role = safeString(input.role).trim();
  if (!chatKey || !text) return null;
  if (role !== "user" && role !== "assistant") return null;
  const timestamp = safeString(
    input.timestamp || new Date().toISOString(),
  ).trim();
  const filePath = koishiChatLogPath(agentDir, chatKey, timestamp);
  ensureDir(path.dirname(filePath));
  const entry: KoishiChatLogEntry = {
    version: 1,
    timestamp,
    chatKey,
    role: role as "user" | "assistant",
    text,
    messageId: safeString(input.messageId).trim() || undefined,
    replyToMessageId: safeString(input.replyToMessageId).trim() || undefined,
    sessionId: safeString(input.sessionId).trim() || undefined,
    sessionFile: safeString(input.sessionFile).trim() || undefined,
    userId: safeString(input.userId).trim() || undefined,
    nickname: safeString(input.nickname).trim() || undefined,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return { entry, filePath };
}

export function readKoishiChatLog(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const filePath = koishiChatLogPath(agentDir, chatKey, date);
  if (!fs.existsSync(filePath))
    return { filePath, entries: [] as KoishiChatLogEntry[] };
  const raw = fs.readFileSync(filePath, "utf8");
  const entries = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as KoishiChatLogEntry;
      } catch {
        return null;
      }
    })
    .filter((item): item is KoishiChatLogEntry => Boolean(item?.text));
  return { filePath, entries };
}

export function formatKoishiChatLog(entries: KoishiChatLogEntry[]) {
  return entries
    .map((entry) => {
      const stamp = safeString(entry.timestamp).trim();
      const role = safeString(entry.role).trim() || "unknown";
      const nick = safeString(entry.nickname).trim();
      const label = role === "user" ? nick || "user" : "assistant";
      return `[${stamp}] ${label}: ${safeString(entry.text).trim()}`;
    })
    .join("\n");
}
