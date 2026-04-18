import path from "node:path";

import {
  findChatMessageByChatAndId,
  listChatMessagesByChatAndDate,
  saveChatMessage,
  updateChatMessage,
  type StoredChatMessage,
} from "./message-store.js";
import { normalizeLocalDateOnly } from "./date.js";
import { parseChatKey } from "./support.js";
import { safeString } from "../text-utils.js";
import { normalizeSessionRef } from "../session/ref.js";

export type ChatLogEntry = {
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

function normalizeRole(value: unknown) {
  const text = safeString(value).trim();
  return text === "user" || text === "assistant"
    ? (text as "user" | "assistant")
    : null;
}

function inferChatType(parsed: { platform: string; chatId: string }) {
  if (parsed.platform === "telegram")
    return parsed.chatId.startsWith("-") ? "group" : "private";
  if (parsed.chatId.startsWith("private:")) return "private";
  return "group";
}

function normalizeStoredText(record: StoredChatMessage) {
  return safeString(
    record.text || record.strippedContent || record.rawContent,
  ).trim();
}

function storedMessageToChatLogEntry(
  record: StoredChatMessage,
): ChatLogEntry | null {
  const role = normalizeRole(record.role);
  const text = normalizeStoredText(record);
  if (!role || !text) return null;
  const session = normalizeSessionRef(record);
  return {
    version: 1,
    timestamp: safeString(record.receivedAt || record.processedAt || "").trim(),
    chatKey: record.chatKey,
    role,
    text,
    messageId: safeString(record.messageId).trim() || undefined,
    replyToMessageId: safeString(record.replyToMessageId).trim() || undefined,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    userId: safeString(record.userId).trim() || undefined,
    nickname: safeString(record.nickname).trim() || undefined,
  };
}

function buildStoredMessageFromChatLogEntry(
  input: Omit<ChatLogEntry, "version">,
): Omit<StoredChatMessage, "version" | "recordKey"> | null {
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
  const session = normalizeSessionRef(input);
  return {
    messageId,
    role,
    replyToMessageId: safeString(input.replyToMessageId).trim() || undefined,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    processedAt: role === "assistant" ? timestamp : undefined,
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

export function chatLogDir(agentDir: string) {
  return path.join(
    path.resolve(agentDir),
    "data",
    "chat-message-store",
    "chat-log-view",
  );
}

export function chatLogPath(agentDir: string, chatKey: string, date: string) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const day = normalizeLocalDateOnly(date, new Date());
  return parsed.botId
    ? path.join(
        chatLogDir(agentDir),
        parsed.platform,
        parsed.botId,
        parsed.chatId,
        `${day}.txt`,
      )
    : path.join(
        chatLogDir(agentDir),
        parsed.platform,
        parsed.chatId,
        `${day}.txt`,
      );
}

export function appendChatLog(
  agentDir: string,
  input: Omit<ChatLogEntry, "version">,
) {
  const normalized = buildStoredMessageFromChatLogEntry(input);
  if (!normalized) return null;
  const existing = findChatMessageByChatAndId(
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
    ? updateChatMessage(
        agentDir,
        normalized.chatKey,
        normalized.messageId,
        patch,
      ) || existing
    : saveChatMessage(agentDir, normalized).record;
  const entry = storedMessageToChatLogEntry(record);
  if (!entry) return null;
  return {
    entry,
    filePath: chatLogPath(agentDir, entry.chatKey, entry.timestamp),
  };
}

export function readChatLog(agentDir: string, chatKey: string, date: string) {
  const filePath = chatLogPath(agentDir, chatKey, date);
  const entries = listChatMessagesByChatAndDate(agentDir, chatKey, date)
    .map((record) => storedMessageToChatLogEntry(record))
    .filter((item): item is ChatLogEntry => Boolean(item));
  return { filePath, entries };
}

export function formatChatLog(entries: ChatLogEntry[]) {
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
