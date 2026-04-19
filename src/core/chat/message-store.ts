import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  type ChatMessageStoreLayout,
  chatScopedDatePath,
  getChatMessageStoreLayout,
  sanitizePathSegment,
} from "./message-store-layout.js";
import { normalizeLocalDateOnly } from "./date.js";
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

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

function dedupeStrings(values: Iterable<unknown>) {
  return [
    ...new Set(
      [...values].map((item) => safeString(item).trim()).filter(Boolean),
    ),
  ];
}

function sameStringLists(
  left: string[] | null | undefined,
  right: string[] | null | undefined,
) {
  const nextLeft = left || [];
  const nextRight = right || [];
  return (
    nextLeft.length === nextRight.length &&
    nextLeft.every((item, index) => item === nextRight[index])
  );
}

function messageStoreLayout(agentDir: string) {
  return getChatMessageStoreLayout(agentDir);
}

export function chatMessageStoreDir(agentDir: string) {
  return messageStoreLayout(agentDir).storeDir;
}

export function chatMessageLogDir(agentDir: string) {
  return messageStoreLayout(agentDir).logDir;
}

export function chatMessageLogPath(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const layout = messageStoreLayout(agentDir);
  return chatScopedDatePath(layout.logDir, chatKey, date, ".txt");
}

function refsPath(indexesRoot: string, messageId: string) {
  const key = hashKey(messageId);
  return path.join(indexesRoot, "by-message-id", key.slice(0, 2), `${key}.json`);
}

function normalizeRefs(value: unknown) {
  return dedupeStrings(Array.isArray(value) ? value : []);
}

function readRefs(indexesRoot: string, messageId: string) {
  const stored = readJsonFile<string[] | null>(refsPath(indexesRoot, messageId), null);
  return stored === null ? null : normalizeRefs(stored);
}

function readPrimaryRefs(layout: ChatMessageStoreLayout, messageId: string) {
  return readRefs(layout.indexesDir, messageId);
}

function readMessageRefs(layout: ChatMessageStoreLayout, messageId: string) {
  const nextMessageId = safeString(messageId).trim();
  if (!nextMessageId) return [];
  const refs: string[] = [];
  for (const root of layout.readRoots) {
    const current = readRefs(root.indexesDir, nextMessageId);
    if (current) refs.push(...current);
  }
  return normalizeRefs(refs);
}

function writeMessageRefs(
  layout: ChatMessageStoreLayout,
  messageId: string,
  refs: string[],
) {
  const nextRefs = normalizeRefs(refs);
  if (sameStringLists(readPrimaryRefs(layout, messageId), nextRefs)) return;
  writeJsonFile(refsPath(layout.indexesDir, messageId), nextRefs);
}

function syncMessageRefs(
  layout: ChatMessageStoreLayout,
  messageId: string,
  relativePath: string,
) {
  const nextRelativePath = safeString(relativePath).trim();
  if (!nextRelativePath) return;
  writeMessageRefs(layout, messageId, [
    ...readMessageRefs(layout, messageId),
    nextRelativePath,
  ]);
}

function recordPath(recordsRoot: string, recordKey: string) {
  return path.join(recordsRoot, recordKey.slice(0, 2), `${recordKey}.json`);
}

type StoredChatDateIndex = {
  version: 1;
  recordKeys: string[];
};

function chatDateIndexPath(indexesRoot: string, chatKey: string, date: string) {
  return chatScopedDatePath(
    path.join(indexesRoot, "by-chat-date"),
    chatKey,
    date,
    ".json",
  );
}

function normalizeRecordKeys(value: unknown) {
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as StoredChatDateIndex | null)?.recordKeys)
      ? (value as StoredChatDateIndex).recordKeys
      : [];
  return dedupeStrings(list);
}

function readChatDateIndexEntry(
  indexesRoot: string,
  chatKey: string,
  date: string,
) {
  const stored = readJsonFile<StoredChatDateIndex | string[] | null>(
    chatDateIndexPath(indexesRoot, chatKey, date),
    null,
  );
  return stored === null ? null : normalizeRecordKeys(stored);
}

function readPrimaryChatDateIndex(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  date: string,
) {
  return readChatDateIndexEntry(layout.indexesDir, chatKey, date);
}

function fallbackReadRoots(layout: ChatMessageStoreLayout) {
  return layout.readRoots.slice(1);
}

function readChatDateIndex(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  date: string,
) {
  const primary = readPrimaryChatDateIndex(layout, chatKey, date);
  if (primary !== null) return primary;
  const recordKeys: string[] = [];
  let found = false;
  for (const root of fallbackReadRoots(layout)) {
    const current = readChatDateIndexEntry(root.indexesDir, chatKey, date);
    if (!current) continue;
    found = true;
    recordKeys.push(...current);
  }
  return found ? normalizeRecordKeys(recordKeys) : null;
}

function writeChatDateIndex(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  date: string,
  recordKeys: string[],
) {
  const nextRecordKeys = normalizeRecordKeys(recordKeys);
  const currentPrimary = readPrimaryChatDateIndex(layout, chatKey, date);
  if (
    currentPrimary !== null &&
    sameStringLists(currentPrimary, nextRecordKeys)
  ) {
    return;
  }
  writeJsonFile(chatDateIndexPath(layout.indexesDir, chatKey, date), {
    version: 1,
    recordKeys: nextRecordKeys,
  } satisfies StoredChatDateIndex);
}

function updateChatDateIndexRecord(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  date: string,
  recordKey: string,
  action: "add" | "remove",
) {
  const nextDate = normalizeLocalDateOnly(date);
  const nextRecordKey = safeString(recordKey).trim();
  if (!nextDate || !nextRecordKey) return;
  const current = readChatDateIndex(layout, chatKey, nextDate) || [];
  const nextRecordKeys =
    action === "remove"
      ? current.filter((item) => item !== nextRecordKey)
      : [...current, nextRecordKey];
  if (action === "remove" && current.length === 0) return;
  writeChatDateIndex(layout, chatKey, nextDate, nextRecordKeys);
}

function storedMessageDate(
  record:
    | Pick<StoredChatMessage, "receivedAt" | "processedAt">
    | null
    | undefined,
) {
  if (!record) return "";
  return normalizeLocalDateOnly(record.receivedAt || record.processedAt || "");
}

function sortChatMessages(messages: StoredChatMessage[]) {
  return [...messages].sort((a, b) => {
    const left = Date.parse(a.receivedAt || a.processedAt || "") || 0;
    const right = Date.parse(b.receivedAt || b.processedAt || "") || 0;
    if (left !== right) return left - right;
    return a.recordKey.localeCompare(b.recordKey);
  });
}

function uniqueChatMessages(messages: StoredChatMessage[]) {
  const out = new Map<string, StoredChatMessage>();
  for (const item of messages) {
    if (!item?.recordKey || out.has(item.recordKey)) continue;
    out.set(item.recordKey, item);
  }
  return [...out.values()];
}

function readStoredChatMessage(filePath: string) {
  const item = readJsonFile<StoredChatMessage | null>(filePath, null);
  return item && safeString(item.messageId).trim() ? item : null;
}

function findChatMessageByRecordKey(
  layout: ChatMessageStoreLayout,
  recordKey: string,
) {
  const nextRecordKey = safeString(recordKey).trim();
  if (!nextRecordKey) return null;
  for (const root of layout.readRoots) {
    const item = readStoredChatMessage(recordPath(root.recordsDir, nextRecordKey));
    if (item) return item;
  }
  return null;
}

function readChatMessagesByRecordKeys(
  layout: ChatMessageStoreLayout,
  recordKeys: string[],
) {
  return uniqueChatMessages(
    normalizeRecordKeys(recordKeys)
      .map((recordKey) => findChatMessageByRecordKey(layout, recordKey))
      .filter((item): item is StoredChatMessage => Boolean(item)),
  );
}

function syncChatDateIndex(
  layout: ChatMessageStoreLayout,
  record: StoredChatMessage,
  previousDate?: string,
) {
  const nextChatKey = safeString(record.chatKey).trim();
  const nextDate = storedMessageDate(record);
  if (!nextChatKey || !record.recordKey) return;
  if (previousDate && previousDate !== nextDate) {
    updateChatDateIndexRecord(
      layout,
      nextChatKey,
      previousDate,
      record.recordKey,
      "remove",
    );
  }
  updateChatDateIndexRecord(layout, nextChatKey, nextDate, record.recordKey, "add");
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

function toStoredChatMessageInput(record: StoredChatMessage) {
  const { version: _version, recordKey: _recordKey, ...input } = record;
  return input;
}

function definedStoredChatMessagePatch(
  input: Partial<Omit<StoredChatMessage, "version" | "recordKey">>,
) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<StoredChatMessage>;
}

function persistChatMessageRecord(
  layout: ChatMessageStoreLayout,
  record: StoredChatMessage,
  previousDate?: string,
) {
  const filePath = recordPath(layout.recordsDir, record.recordKey);
  writeJsonFile(filePath, record);
  syncMessageRefs(
    layout,
    record.messageId,
    path.relative(layout.storeDir, filePath),
  );
  syncChatDateIndex(layout, record, previousDate);
  return filePath;
}

function getChatMessagesByMessageIdWithLayout(
  layout: ChatMessageStoreLayout,
  messageId: string,
) {
  const nextMessageId = safeString(messageId).trim();
  if (!nextMessageId) return [] as StoredChatMessage[];
  const matches: StoredChatMessage[] = [];
  for (const root of layout.readRoots) {
    const refs = readRefs(root.indexesDir, nextMessageId) || [];
    for (const relativePath of refs) {
      const nextRelativePath = safeString(relativePath).trim();
      if (!nextRelativePath) continue;
      const item = readStoredChatMessage(path.join(root.storeDir, nextRelativePath));
      if (item) matches.push(item);
    }
  }
  return uniqueChatMessages(matches);
}

function getChatMessageWithLayout(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  messageId: string,
) {
  return findChatMessageByRecordKey(
    layout,
    buildChatMessageRecordKey(chatKey, messageId),
  );
}

function findChatMessageByChatAndIdWithLayout(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  messageId: string,
) {
  const direct = getChatMessageWithLayout(layout, chatKey, messageId);
  if (direct) return direct;
  return (
    getChatMessagesByMessageIdWithLayout(layout, messageId).find(
      (item) => item.chatKey === chatKey,
    ) || null
  );
}

function listChatMessagesWithLayout(layout: ChatMessageStoreLayout) {
  const out = new Map<string, StoredChatMessage>();
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
      const item = readStoredChatMessage(filePath);
      if (item && !out.has(item.recordKey)) out.set(item.recordKey, item);
    }
  };
  for (const root of layout.readRoots) {
    visit(root.recordsDir);
  }
  return [...out.values()];
}

function saveChatMessageWithLayout(
  layout: ChatMessageStoreLayout,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const record = buildStoredChatMessage(input);
  const previous = getChatMessageWithLayout(layout, record.chatKey, record.messageId);
  const filePath = persistChatMessageRecord(layout, record, storedMessageDate(previous));
  return { record, filePath };
}

function updateChatMessageWithLayout(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  messageId: string,
  patch: Partial<StoredChatMessage>,
) {
  const current = getChatMessageWithLayout(layout, chatKey, messageId);
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
  persistChatMessageRecord(layout, next, previousDate);
  return next;
}

export function saveChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  return saveChatMessageWithLayout(messageStoreLayout(agentDir), input);
}

export function upsertChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const layout = messageStoreLayout(agentDir);
  const normalized = buildStoredChatMessage(input);
  const existing = findChatMessageByChatAndIdWithLayout(
    layout,
    normalized.chatKey,
    normalized.messageId,
  );
  if (!existing) {
    return saveChatMessageWithLayout(layout, toStoredChatMessageInput(normalized)).record;
  }
  return (
    updateChatMessageWithLayout(
      layout,
      normalized.chatKey,
      normalized.messageId,
      definedStoredChatMessagePatch(toStoredChatMessageInput(normalized)),
    ) || existing
  );
}

export function getChatMessagesByMessageId(
  agentDir: string,
  messageId: string,
) {
  return getChatMessagesByMessageIdWithLayout(messageStoreLayout(agentDir), messageId);
}

export function getChatMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return getChatMessageWithLayout(messageStoreLayout(agentDir), chatKey, messageId);
}

export function updateChatMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
  patch: Partial<StoredChatMessage>,
) {
  return updateChatMessageWithLayout(
    messageStoreLayout(agentDir),
    chatKey,
    messageId,
    patch,
  );
}

export function findChatMessageByChatAndId(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return findChatMessageByChatAndIdWithLayout(
    messageStoreLayout(agentDir),
    chatKey,
    messageId,
  );
}

export function listChatMessages(agentDir: string) {
  return listChatMessagesWithLayout(messageStoreLayout(agentDir));
}

export function listChatMessagesByChatAndDate(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const layout = messageStoreLayout(agentDir);
  const nextChatKey = safeString(chatKey).trim();
  const nextDate = normalizeLocalDateOnly(date);
  if (!nextChatKey || !nextDate) return [];

  const indexedRecordKeys = readChatDateIndex(layout, nextChatKey, nextDate);
  if (indexedRecordKeys) {
    writeChatDateIndex(layout, nextChatKey, nextDate, indexedRecordKeys);
    return sortChatMessages(
      readChatMessagesByRecordKeys(layout, indexedRecordKeys).filter(
        (item) =>
          item.chatKey === nextChatKey && storedMessageDate(item) === nextDate,
      ),
    );
  }

  const records = sortChatMessages(
    listChatMessagesWithLayout(layout).filter(
      (item) =>
        item.chatKey === nextChatKey && storedMessageDate(item) === nextDate,
    ),
  );
  writeChatDateIndex(
    layout,
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
  const layout = messageStoreLayout(agentDir);
  const nextChatKey = safeString(chatKey).trim();
  const matches = nextChatKey
    ? (() => {
        const found = findChatMessageByChatAndIdWithLayout(
          layout,
          nextChatKey,
          messageId,
        );
        return found ? [found] : [];
      })()
    : getChatMessagesByMessageIdWithLayout(layout, messageId);

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
