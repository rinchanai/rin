import path from "node:path";

import {
  findKoishiMessageByChatAndId,
  listKoishiMessagesByChatAndDate,
  saveKoishiMessage,
  updateKoishiMessage,
  type StoredKoishiMessage,
} from "./message-store.js";
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

function normalizeRole(value: unknown) {
  const text = safeString(value).trim();
  return text === "user" || text === "assistant"
    ? (text as "user" | "assistant")
    : null;
}

function normalizeDateOnly(value: string) {
  const text = safeString(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const date = text ? new Date(text) : new Date();
  if (Number.isNaN(date.getTime()))
    return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function inferChatType(parsed: { platform: string; chatId: string }) {
  if (parsed.platform === "telegram")
    return parsed.chatId.startsWith("-") ? "group" : "private";
  if (parsed.chatId.startsWith("private:")) return "private";
  return "group";
}

function normalizeStoredText(record: StoredKoishiMessage) {
  return safeString(
    record.text || record.strippedContent || record.rawContent,
  ).trim();
}

function storedMessageToChatLogEntry(
  record: StoredKoishiMessage,
): KoishiChatLogEntry | null {
  const role = normalizeRole(record.role);
  const text = normalizeStoredText(record);
  if (!role || !text) return null;
  return {
    version: 1,
    timestamp: safeString(record.receivedAt || record.processedAt || "").trim(),
    chatKey: record.chatKey,
    role,
    text,
    messageId: safeString(record.messageId).trim() || undefined,
    replyToMessageId: safeString(record.replyToMessageId).trim() || undefined,
    sessionId: safeString(record.sessionId).trim() || undefined,
    sessionFile: safeString(record.sessionFile).trim() || undefined,
    userId: safeString(record.userId).trim() || undefined,
    nickname: safeString(record.nickname).trim() || undefined,
  };
}

function buildStoredMessageFromChatLogEntry(
  input: Omit<KoishiChatLogEntry, "version">,
): Omit<StoredKoishiMessage, "version" | "recordKey"> | null {
  const chatKey = safeString(input.chatKey).trim();
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const role = normalizeRole(input.role);
  const text = safeString(input.text).trim();
  const messageId = safeString(input.messageId).trim();
  const timestamp = safeString(
    input.timestamp || new Date().toISOString(),
  ).trim();
  if (!role || !text || !messageId) return null;
  return {
    messageId,
    role,
    replyToMessageId: safeString(input.replyToMessageId).trim() || undefined,
    sessionId: safeString(input.sessionId).trim() || undefined,
    sessionFile: safeString(input.sessionFile).trim() || undefined,
    processedAt: timestamp,
    chatKey,
    platform: parsed.platform,
    botId: parsed.botId || undefined,
    chatId: parsed.chatId,
    chatType: inferChatType(parsed),
    receivedAt: timestamp,
    userId: safeString(input.userId).trim() || undefined,
    nickname: safeString(input.nickname).trim() || undefined,
    text,
    rawContent: text,
    strippedContent: text,
  };
}

export function koishiChatLogDir(agentDir: string) {
  return path.join(
    path.resolve(agentDir),
    "data",
    "koishi-message-store",
    "chat-log-view",
  );
}

export function koishiChatLogPath(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const day = normalizeDateOnly(date);
  return parsed.botId
    ? path.join(
        koishiChatLogDir(agentDir),
        parsed.platform,
        parsed.botId,
        parsed.chatId,
        `${day}.txt`,
      )
    : path.join(
        koishiChatLogDir(agentDir),
        parsed.platform,
        parsed.chatId,
        `${day}.txt`,
      );
}

export function appendKoishiChatLog(
  agentDir: string,
  input: Omit<KoishiChatLogEntry, "version">,
) {
  const normalized = buildStoredMessageFromChatLogEntry(input);
  if (!normalized) return null;
  const existing = findKoishiMessageByChatAndId(
    agentDir,
    normalized.chatKey,
    normalized.messageId,
  );
  const patch = Object.fromEntries(
    Object.entries({
      role: normalized.role,
      replyToMessageId: normalized.replyToMessageId,
      sessionId: normalized.sessionId,
      sessionFile: normalized.sessionFile,
      processedAt: normalized.processedAt,
      receivedAt: normalized.receivedAt,
      userId: normalized.userId,
      nickname: normalized.nickname,
      text: normalized.text,
      rawContent: normalized.rawContent,
      strippedContent: normalized.strippedContent,
    }).filter(([, value]) => value !== undefined),
  );
  const record = existing
    ? updateKoishiMessage(
        agentDir,
        normalized.chatKey,
        normalized.messageId,
        patch,
      ) || existing
    : saveKoishiMessage(agentDir, normalized).record;
  const entry = storedMessageToChatLogEntry(record);
  if (!entry) return null;
  return {
    entry,
    filePath: koishiChatLogPath(agentDir, entry.chatKey, entry.timestamp),
  };
}

export function readKoishiChatLog(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const filePath = koishiChatLogPath(agentDir, chatKey, date);
  const entries = listKoishiMessagesByChatAndDate(agentDir, chatKey, date)
    .map((record) => storedMessageToChatLogEntry(record))
    .filter((item): item is KoishiChatLogEntry => Boolean(item));
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
