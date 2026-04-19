import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

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

function sanitizePathSegment(value: string, fallback: string) {
  const text = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_");
  return text || fallback;
}

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

type ChatMessageStoreLayout = {
  preferredStoreDir: string;
  legacyStoreDir: string;
  storeDir: string;
  fallbackStoreDir?: string;
  recordsDir: string;
  indexesDir: string;
  logDir: string;
  source: "preferred" | "legacy" | "implicit-preferred";
};

function recordsDirForStoreDir(storeDir: string) {
  return path.join(storeDir, "records");
}

function indexesDirForStoreDir(storeDir: string) {
  return path.join(storeDir, "indexes");
}

function buildChatMessageStoreLayout(
  preferredStoreDir: string,
  legacyStoreDir: string,
  storeDir: string,
  fallbackStoreDir: string | undefined,
  source: ChatMessageStoreLayout["source"],
): ChatMessageStoreLayout {
  return {
    preferredStoreDir,
    legacyStoreDir,
    storeDir,
    fallbackStoreDir,
    recordsDir: recordsDirForStoreDir(storeDir),
    indexesDir: indexesDirForStoreDir(storeDir),
    logDir: path.join(storeDir, "chat-log-view"),
    source,
  };
}

function detectChatMessageStoreLayout(rootDir: string) {
  const preferredStoreDir = path.join(rootDir, "data", "chat-message-store");
  const legacyStoreDir = path.join(rootDir, "data", "koishi-message-store");
  const hasPreferred = fs.existsSync(preferredStoreDir);
  const hasLegacy = fs.existsSync(legacyStoreDir);
  if (hasPreferred) {
    return buildChatMessageStoreLayout(
      preferredStoreDir,
      legacyStoreDir,
      preferredStoreDir,
      hasLegacy ? legacyStoreDir : undefined,
      "preferred",
    );
  }
  if (hasLegacy) {
    return buildChatMessageStoreLayout(
      preferredStoreDir,
      legacyStoreDir,
      legacyStoreDir,
      undefined,
      "legacy",
    );
  }
  return buildChatMessageStoreLayout(
    preferredStoreDir,
    legacyStoreDir,
    preferredStoreDir,
    undefined,
    "implicit-preferred",
  );
}

function getChatMessageStoreLayout(agentDir: string) {
  return detectChatMessageStoreLayout(path.resolve(agentDir));
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

function chatMessageStoreRoots(agentDir: string) {
  const layout = getChatMessageStoreLayout(agentDir);
  return dedupeStrings([layout.storeDir, layout.fallbackStoreDir]);
}

function recordRoots(agentDir: string) {
  return chatMessageStoreRoots(agentDir).map((storeDir) =>
    recordsDirForStoreDir(storeDir),
  );
}

function indexRoots(agentDir: string) {
  return chatMessageStoreRoots(agentDir).map((storeDir) =>
    indexesDirForStoreDir(storeDir),
  );
}

export function chatMessageStoreDir(agentDir: string) {
  return getChatMessageStoreLayout(agentDir).storeDir;
}

function recordsDir(agentDir: string) {
  return getChatMessageStoreLayout(agentDir).recordsDir;
}

function indexesDir(agentDir: string) {
  return getChatMessageStoreLayout(agentDir).indexesDir;
}

function chatScopedDatePath(
  rootDir: string,
  chatKey: string,
  date: string,
  extension: ".json" | ".txt",
) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const day = normalizeLocalDateOnly(date, new Date());
  const platform = sanitizePathSegment(parsed.platform, "platform");
  const chatId = sanitizePathSegment(parsed.chatId, "chat");
  return parsed.botId
    ? path.join(
        rootDir,
        platform,
        sanitizePathSegment(parsed.botId, "bot"),
        chatId,
        `${day}${extension}`,
      )
    : path.join(rootDir, platform, chatId, `${day}${extension}`);
}

export function chatMessageLogDir(agentDir: string) {
  return getChatMessageStoreLayout(agentDir).logDir;
}

export function chatMessageLogPath(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  return chatScopedDatePath(chatMessageLogDir(agentDir), chatKey, date, ".txt");
}

function refsPathForIndexesDir(indexesRoot: string, messageId: string) {
  const key = hashKey(messageId);
  return path.join(
    indexesRoot,
    "by-message-id",
    key.slice(0, 2),
    `${key}.json`,
  );
}

function refsPath(agentDir: string, messageId: string) {
  return refsPathForIndexesDir(indexesDir(agentDir), messageId);
}

function normalizeRefs(value: unknown) {
  return dedupeStrings(Array.isArray(value) ? value : []);
}

function readRefsForIndexesDir(indexesRoot: string, messageId: string) {
  const stored = readJsonFile<string[] | null>(
    refsPathForIndexesDir(indexesRoot, messageId),
    null,
  );
  return stored === null ? null : normalizeRefs(stored);
}

function readPrimaryRefs(agentDir: string, messageId: string) {
  return readRefsForIndexesDir(indexesDir(agentDir), messageId);
}

function readMessageRefs(agentDir: string, messageId: string) {
  const nextMessageId = safeString(messageId).trim();
  if (!nextMessageId) return [];
  const refs: string[] = [];
  for (const root of indexRoots(agentDir)) {
    const current = readRefsForIndexesDir(root, nextMessageId);
    if (current) refs.push(...current);
  }
  return normalizeRefs(refs);
}

function writeMessageRefs(agentDir: string, messageId: string, refs: string[]) {
  const nextRefs = normalizeRefs(refs);
  if (sameStringLists(readPrimaryRefs(agentDir, messageId), nextRefs)) return;
  writeJsonFile(refsPath(agentDir, messageId), nextRefs);
}

function syncMessageRefs(
  agentDir: string,
  messageId: string,
  relativePath: string,
) {
  const nextRelativePath = safeString(relativePath).trim();
  if (!nextRelativePath) return;
  writeMessageRefs(agentDir, messageId, [
    ...readMessageRefs(agentDir, messageId),
    nextRelativePath,
  ]);
}

function recordPathForRecordsDir(recordsRoot: string, recordKey: string) {
  return path.join(recordsRoot, recordKey.slice(0, 2), `${recordKey}.json`);
}

function recordPath(agentDir: string, recordKey: string) {
  return recordPathForRecordsDir(recordsDir(agentDir), recordKey);
}

type StoredChatDateIndex = {
  version: 1;
  recordKeys: string[];
};

function chatDateIndexPathForIndexesDir(
  indexesRoot: string,
  chatKey: string,
  date: string,
) {
  return chatScopedDatePath(
    path.join(indexesRoot, "by-chat-date"),
    chatKey,
    date,
    ".json",
  );
}

function chatDateIndexPath(agentDir: string, chatKey: string, date: string) {
  return chatDateIndexPathForIndexesDir(indexesDir(agentDir), chatKey, date);
}

function normalizeRecordKeys(value: unknown) {
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as StoredChatDateIndex | null)?.recordKeys)
      ? (value as StoredChatDateIndex).recordKeys
      : [];
  return dedupeStrings(list);
}

function readChatDateIndexForIndexesDir(
  indexesRoot: string,
  chatKey: string,
  date: string,
) {
  const stored = readJsonFile<StoredChatDateIndex | string[] | null>(
    chatDateIndexPathForIndexesDir(indexesRoot, chatKey, date),
    null,
  );
  return stored === null ? null : normalizeRecordKeys(stored);
}

function readPrimaryChatDateIndex(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  return readChatDateIndexForIndexesDir(indexesDir(agentDir), chatKey, date);
}

function readChatDateIndex(agentDir: string, chatKey: string, date: string) {
  const primary = readPrimaryChatDateIndex(agentDir, chatKey, date);
  if (primary !== null) return primary;
  const recordKeys: string[] = [];
  let found = false;
  for (const root of indexRoots(agentDir).slice(1)) {
    const current = readChatDateIndexForIndexesDir(root, chatKey, date);
    if (!current) continue;
    found = true;
    recordKeys.push(...current);
  }
  return found ? normalizeRecordKeys(recordKeys) : null;
}

function writeChatDateIndex(
  agentDir: string,
  chatKey: string,
  date: string,
  recordKeys: string[],
) {
  const nextRecordKeys = normalizeRecordKeys(recordKeys);
  const currentPrimary = readPrimaryChatDateIndex(agentDir, chatKey, date);
  if (
    currentPrimary !== null &&
    sameStringLists(currentPrimary, nextRecordKeys)
  ) {
    return;
  }
  writeJsonFile(chatDateIndexPath(agentDir, chatKey, date), {
    version: 1,
    recordKeys: nextRecordKeys,
  } satisfies StoredChatDateIndex);
}

function updateChatDateIndexRecord(
  agentDir: string,
  chatKey: string,
  date: string,
  recordKey: string,
  action: "add" | "remove",
) {
  const nextDate = normalizeLocalDateOnly(date);
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

function findChatMessageByRecordKey(agentDir: string, recordKey: string) {
  const nextRecordKey = safeString(recordKey).trim();
  if (!nextRecordKey) return null;
  for (const root of recordRoots(agentDir)) {
    const item = readStoredChatMessage(
      recordPathForRecordsDir(root, nextRecordKey),
    );
    if (item) return item;
  }
  return null;
}

function readChatMessagesByRecordKeys(agentDir: string, recordKeys: string[]) {
  return uniqueChatMessages(
    normalizeRecordKeys(recordKeys)
      .map((recordKey) => findChatMessageByRecordKey(agentDir, recordKey))
      .filter((item): item is StoredChatMessage => Boolean(item)),
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

export function saveChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const record = buildStoredChatMessage(input);
  const previous = getChatMessage(agentDir, record.chatKey, record.messageId);
  const filePath = recordPath(agentDir, record.recordKey);
  writeJsonFile(filePath, record);

  const storeLayout = getChatMessageStoreLayout(agentDir);
  syncMessageRefs(
    agentDir,
    record.messageId,
    path.relative(storeLayout.storeDir, filePath),
  );
  syncChatDateIndex(agentDir, record, storedMessageDate(previous));

  return { record, filePath };
}

export function upsertChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const normalized = buildStoredChatMessage(input);
  const existing = findChatMessageByChatAndId(
    agentDir,
    normalized.chatKey,
    normalized.messageId,
  );
  if (!existing) {
    return saveChatMessage(agentDir, toStoredChatMessageInput(normalized))
      .record;
  }
  return (
    updateChatMessage(
      agentDir,
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
  const nextMessageId = safeString(messageId).trim();
  if (!nextMessageId) return [] as StoredChatMessage[];
  const matches: StoredChatMessage[] = [];
  for (const storeDir of chatMessageStoreRoots(agentDir)) {
    const refs =
      readRefsForIndexesDir(indexesDirForStoreDir(storeDir), nextMessageId) ||
      [];
    for (const relativePath of refs) {
      const nextRelativePath = safeString(relativePath).trim();
      if (!nextRelativePath) continue;
      const item = readStoredChatMessage(path.join(storeDir, nextRelativePath));
      if (item) matches.push(item);
    }
  }
  return uniqueChatMessages(matches);
}

export function getChatMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return findChatMessageByRecordKey(
    agentDir,
    buildChatMessageRecordKey(chatKey, messageId),
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
  const filePath = recordPath(agentDir, current.recordKey);
  writeJsonFile(filePath, next);
  const storeLayout = getChatMessageStoreLayout(agentDir);
  syncMessageRefs(
    agentDir,
    current.messageId,
    path.relative(storeLayout.storeDir, filePath),
  );
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
  for (const root of recordRoots(agentDir)) {
    visit(root);
  }
  return [...out.values()];
}

export function listChatMessagesByChatAndDate(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextDate = normalizeLocalDateOnly(date);
  if (!nextChatKey || !nextDate) return [];

  const indexedRecordKeys = readChatDateIndex(agentDir, nextChatKey, nextDate);
  if (indexedRecordKeys) {
    writeChatDateIndex(agentDir, nextChatKey, nextDate, indexedRecordKeys);
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
