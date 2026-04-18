import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { parseChatKey, readJsonFile, writeJsonFile } from "./support.js";
import { safeString } from "../text-utils.js";

export type StoredChatMessage = {
  version: 1;
  recordKey: string;
  messageId: string;
  role?: "user" | "assistant";
  replyToMessageId?: string;
  sessionId?: string;
  sessionFile?: string;
  acceptedAt?: string;
  processedAt?: string;
  chatKey: string;
  platform: string;
  botId?: string;
  chatId: string;
  chatType?: "private" | "group";
  receivedAt: string;
  platformTimestamp?: number;
  userId?: string;
  nickname?: string;
  chatName?: string;
  trust?: string;
  text?: string;
  rawContent?: string;
  strippedContent?: string;
  elements?: Array<{ type: string; attrs?: Record<string, string> }>;
  quote?: {
    messageId?: string;
    userId?: string;
    nickname?: string;
    content?: string;
  };
};

function sanitizePathSegment(value: string, fallback: string) {
  const text = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_");
  return text || fallback;
}

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

export function chatMessageStoreDir(agentDir: string) {
  const root = path.resolve(agentDir);
  const preferred = path.join(root, "data", "chat-message-store");
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(root, "data", "koishi-message-store");
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

function recordsDir(agentDir: string) {
  return path.join(chatMessageStoreDir(agentDir), "records");
}

function indexesDir(agentDir: string) {
  return path.join(chatMessageStoreDir(agentDir), "indexes");
}

function refsPath(agentDir: string, messageId: string) {
  const key = hashKey(messageId);
  return path.join(
    indexesDir(agentDir),
    "by-message-id",
    key.slice(0, 2),
    `${key}.json`,
  );
}

function recordPath(agentDir: string, recordKey: string) {
  return path.join(
    recordsDir(agentDir),
    recordKey.slice(0, 2),
    `${recordKey}.json`,
  );
}

type StoredChatDateIndex = {
  version: 1;
  recordKeys: string[];
};

function chatDateIndexPath(agentDir: string, chatKey: string, date: string) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const day = isoDateOnly(date);
  const platform = sanitizePathSegment(parsed.platform, "platform");
  const chatId = sanitizePathSegment(parsed.chatId, "chat");
  return parsed.botId
    ? path.join(
        indexesDir(agentDir),
        "by-chat-date",
        platform,
        sanitizePathSegment(parsed.botId, "bot"),
        chatId,
        `${day}.json`,
      )
    : path.join(
        indexesDir(agentDir),
        "by-chat-date",
        platform,
        chatId,
        `${day}.json`,
      );
}

function normalizeRecordKeys(value: unknown) {
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as StoredChatDateIndex | null)?.recordKeys)
      ? (value as StoredChatDateIndex).recordKeys
      : [];
  return [
    ...new Set(list.map((item) => safeString(item).trim()).filter(Boolean)),
  ];
}

function readChatDateIndex(agentDir: string, chatKey: string, date: string) {
  const stored = readJsonFile<StoredChatDateIndex | string[] | null>(
    chatDateIndexPath(agentDir, chatKey, date),
    null,
  );
  return stored === null ? null : normalizeRecordKeys(stored);
}

function writeChatDateIndex(
  agentDir: string,
  chatKey: string,
  date: string,
  recordKeys: string[],
) {
  writeJsonFile(chatDateIndexPath(agentDir, chatKey, date), {
    version: 1,
    recordKeys: normalizeRecordKeys(recordKeys),
  } satisfies StoredChatDateIndex);
}

function updateChatDateIndexRecord(
  agentDir: string,
  chatKey: string,
  date: string,
  recordKey: string,
  action: "add" | "remove",
) {
  const nextDate = isoDateOnly(date);
  const nextRecordKey = safeString(recordKey).trim();
  if (!nextDate || !nextRecordKey) return;
  const current = readChatDateIndex(agentDir, chatKey, nextDate) || [];
  const nextRecordKeys =
    action === "remove"
      ? current.filter((item) => item !== nextRecordKey)
      : [...current, nextRecordKey];
  if (action === "remove" && current.length === 0) return;
  writeChatDateIndex(agentDir, chatKey, nextDate, nextRecordKeys);
}

function storedMessageDate(
  record:
    | Pick<StoredChatMessage, "receivedAt" | "processedAt">
    | null
    | undefined,
) {
  if (!record) return "";
  return isoDateOnly(record.receivedAt || record.processedAt || "");
}

function sortChatMessages(messages: StoredChatMessage[]) {
  return [...messages].sort((a, b) => {
    const left = Date.parse(a.receivedAt || a.processedAt || "") || 0;
    const right = Date.parse(b.receivedAt || b.processedAt || "") || 0;
    if (left !== right) return left - right;
    return a.recordKey.localeCompare(b.recordKey);
  });
}

function readChatMessagesByRecordKeys(agentDir: string, recordKeys: string[]) {
  return normalizeRecordKeys(recordKeys)
    .map((recordKey) =>
      readJsonFile<StoredChatMessage | null>(
        recordPath(agentDir, recordKey),
        null,
      ),
    )
    .filter((item): item is StoredChatMessage =>
      Boolean(item && safeString(item.messageId).trim()),
    );
}

function syncChatDateIndex(
  agentDir: string,
  record: StoredChatMessage,
  previousDate?: string,
) {
  const nextChatKey = safeString(record.chatKey).trim();
  const nextDate = storedMessageDate(record);
  if (!nextChatKey || !record.recordKey) return;
  if (previousDate && previousDate !== nextDate) {
    updateChatDateIndexRecord(
      agentDir,
      nextChatKey,
      previousDate,
      record.recordKey,
      "remove",
    );
  }
  updateChatDateIndexRecord(
    agentDir,
    nextChatKey,
    nextDate,
    record.recordKey,
    "add",
  );
}

function normalizeStoredRole(value: unknown) {
  const text = safeString(value).trim();
  return text === "user" || text === "assistant"
    ? (text as "user" | "assistant")
    : undefined;
}

export function buildChatMessageRecordKey(chatKey: string, messageId: string) {
  return hashKey(`${chatKey}\n${messageId}`);
}

export function buildStoredChatMessage(
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const chatKey = safeString(input.chatKey).trim();
  const messageId = safeString(input.messageId).trim();
  if (!chatKey) throw new Error("chat_message_store_chatKey_required");
  if (!messageId) throw new Error("chat_message_store_messageId_required");
  return {
    ...input,
    version: 1 as const,
    recordKey: buildChatMessageRecordKey(chatKey, messageId),
    messageId,
    role: normalizeStoredRole(input.role),
    chatKey,
  };
}

export function saveChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const record = buildStoredChatMessage(input);
  const previous = getChatMessage(agentDir, record.chatKey, record.messageId);
  const filePath = recordPath(agentDir, record.recordKey);
  writeJsonFile(filePath, record);

  const refFilePath = refsPath(agentDir, record.messageId);
  const refs = readJsonFile<string[]>(refFilePath, []);
  const relative = path.relative(chatMessageStoreDir(agentDir), filePath);
  if (!refs.includes(relative)) {
    writeJsonFile(refFilePath, [...refs, relative]);
  }
  syncChatDateIndex(agentDir, record, storedMessageDate(previous));

  return { record, filePath };
}

export function getChatMessagesByMessageId(
  agentDir: string,
  messageId: string,
) {
  const nextMessageId = safeString(messageId).trim();
  if (!nextMessageId) return [] as StoredChatMessage[];
  const refFilePath = refsPath(agentDir, nextMessageId);
  const refs = readJsonFile<string[]>(refFilePath, []);
  const storeRoot = chatMessageStoreDir(agentDir);
  return refs
    .map((relativePath) =>
      readJsonFile<StoredChatMessage | null>(
        path.join(storeRoot, relativePath),
        null,
      ),
    )
    .filter((item): item is StoredChatMessage =>
      Boolean(item && safeString(item.messageId).trim()),
    );
}

export function getChatMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  const recordKey = buildChatMessageRecordKey(chatKey, messageId);
  return readJsonFile<StoredChatMessage | null>(
    recordPath(agentDir, recordKey),
    null,
  );
}

export function updateChatMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
  patch: Partial<StoredChatMessage>,
) {
  const current = getChatMessage(agentDir, chatKey, messageId);
  if (!current) return null;
  const previousDate = storedMessageDate(current);
  const next: StoredChatMessage = {
    ...current,
    ...patch,
    version: 1,
    recordKey: current.recordKey,
    chatKey: current.chatKey,
    messageId: current.messageId,
    role: normalizeStoredRole(patch.role) || current.role,
    platform: current.platform,
    chatId: current.chatId,
  };
  writeJsonFile(recordPath(agentDir, current.recordKey), next);
  syncChatDateIndex(agentDir, next, previousDate);
  return next;
}

export function findChatMessageByChatAndId(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  const direct = getChatMessage(agentDir, chatKey, messageId);
  if (direct) return direct;
  return (
    getChatMessagesByMessageId(agentDir, messageId).find(
      (item) => item.chatKey === chatKey,
    ) || null
  );
}

export function listChatMessages(agentDir: string) {
  const root = recordsDir(agentDir);
  const out: StoredChatMessage[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const item = readJsonFile<StoredChatMessage | null>(filePath, null);
      if (item && safeString(item.messageId).trim()) out.push(item);
    }
  };
  visit(root);
  return out;
}

function isoDateOnly(value: string) {
  const match = safeString(value)
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function listChatMessagesByChatAndDate(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextDate = isoDateOnly(date);
  if (!nextChatKey || !nextDate) return [];

  const indexedRecordKeys = readChatDateIndex(agentDir, nextChatKey, nextDate);
  if (indexedRecordKeys) {
    return sortChatMessages(
      readChatMessagesByRecordKeys(agentDir, indexedRecordKeys).filter(
        (item) =>
          item.chatKey === nextChatKey && storedMessageDate(item) === nextDate,
      ),
    );
  }

  const records = sortChatMessages(
    listChatMessages(agentDir).filter(
      (item) =>
        item.chatKey === nextChatKey && storedMessageDate(item) === nextDate,
    ),
  );
  writeChatDateIndex(
    agentDir,
    nextChatKey,
    nextDate,
    records.map((item) => item.recordKey),
  );
  return records;
}

export function normalizeChatMessageLookup(
  agentDir: string,
  messageId: string,
  chatKey?: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const matches = nextChatKey
    ? (() => {
        const found = findChatMessageByChatAndId(
          agentDir,
          nextChatKey,
          messageId,
        );
        return found ? [found] : [];
      })()
    : getChatMessagesByMessageId(agentDir, messageId);

  return matches.map((item) => ({
    ...item,
    parsedChatKey: parseChatKey(item.chatKey),
  }));
}

export function describeChatMessageRecord(record: StoredChatMessage) {
  return [
    `messageId=${record.messageId}`,
    `chatKey=${record.chatKey}`,
    record.role ? `role=${record.role}` : "",
    record.replyToMessageId
      ? `replyToMessageId=${record.replyToMessageId}`
      : "",
    record.sessionId ? `sessionId=${record.sessionId}` : "",
    record.sessionFile ? `sessionFile=${record.sessionFile}` : "",
    record.userId ? `userId=${record.userId}` : "",
    record.nickname ? `nickname=${record.nickname}` : "",
    record.chatName ? `chatName=${record.chatName}` : "",
    record.trust ? `trust=${record.trust}` : "",
    record.receivedAt ? `receivedAt=${record.receivedAt}` : "",
    record.text ? `text=${record.text}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function summarizeChatMessageRecord(record: StoredChatMessage) {
  return [
    `- message id: ${record.messageId}`,
    `- chatKey: ${record.chatKey}`,
    record.role ? `- role: ${record.role}` : "",
    record.replyToMessageId ? `- reply to: ${record.replyToMessageId}` : "",
    record.sessionId ? `- session id: ${record.sessionId}` : "",
    record.sessionFile ? `- session file: ${record.sessionFile}` : "",
    record.userId ? `- sender user id: ${record.userId}` : "",
    record.nickname ? `- sender nickname: ${record.nickname}` : "",
    record.chatName ? `- chat name: ${record.chatName}` : "",
    record.trust ? `- sender trust: ${record.trust}` : "",
    record.receivedAt ? `- received at: ${record.receivedAt}` : "",
    record.text ? `- text: ${record.text}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function normalizeElementSummary(
  elements: any,
): Array<{ type: string; attrs?: Record<string, string> }> {
  if (!Array.isArray(elements)) return [];
  return elements.map((element) => {
    const attrs =
      element?.attrs && typeof element.attrs === "object"
        ? Object.fromEntries(
            Object.entries(element.attrs)
              .map(([key, value]) => [key, safeString(value)])
              .filter(([, value]) => value),
          )
        : undefined;
    return {
      type: sanitizePathSegment(
        safeString(element?.type).toLowerCase(),
        "unknown",
      ),
      ...(attrs && Object.keys(attrs).length ? { attrs } : {}),
    };
  });
}
