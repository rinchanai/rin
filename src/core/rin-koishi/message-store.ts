import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { parseChatKey, readJsonFile, writeJsonFile } from "./support.js";

export type StoredKoishiMessage = {
  version: 1;
  recordKey: string;
  messageId: string;
  replyToMessageId?: string;
  sessionId?: string;
  sessionFile?: string;
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

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizePathSegment(value: string, fallback: string) {
  const text = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_");
  return text || fallback;
}

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

export function koishiMessageStoreDir(agentDir: string) {
  return path.join(path.resolve(agentDir), "data", "koishi-message-store");
}

function recordsDir(agentDir: string) {
  return path.join(koishiMessageStoreDir(agentDir), "records");
}

function indexesDir(agentDir: string) {
  return path.join(koishiMessageStoreDir(agentDir), "indexes");
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

export function buildKoishiMessageRecordKey(
  chatKey: string,
  messageId: string,
) {
  return hashKey(`${chatKey}\n${messageId}`);
}

export function buildStoredKoishiMessage(
  input: Omit<StoredKoishiMessage, "version" | "recordKey">,
) {
  const chatKey = safeString(input.chatKey).trim();
  const messageId = safeString(input.messageId).trim();
  if (!chatKey) throw new Error("koishi_message_store_chatKey_required");
  if (!messageId) throw new Error("koishi_message_store_messageId_required");
  return {
    ...input,
    version: 1 as const,
    recordKey: buildKoishiMessageRecordKey(chatKey, messageId),
    messageId,
    chatKey,
  };
}

export function saveKoishiMessage(
  agentDir: string,
  input: Omit<StoredKoishiMessage, "version" | "recordKey">,
) {
  const record = buildStoredKoishiMessage(input);
  const filePath = recordPath(agentDir, record.recordKey);
  writeJsonFile(filePath, record);

  const refFilePath = refsPath(agentDir, record.messageId);
  const refs = readJsonFile<string[]>(refFilePath, []);
  const relative = path.relative(koishiMessageStoreDir(agentDir), filePath);
  if (!refs.includes(relative)) {
    ensureDir(path.dirname(refFilePath));
    fs.writeFileSync(
      refFilePath,
      `${JSON.stringify([...refs, relative], null, 2)}\n`,
      "utf8",
    );
  }

  return { record, filePath };
}

export function getKoishiMessagesByMessageId(
  agentDir: string,
  messageId: string,
) {
  const nextMessageId = safeString(messageId).trim();
  if (!nextMessageId) return [] as StoredKoishiMessage[];
  const refFilePath = refsPath(agentDir, nextMessageId);
  const refs = readJsonFile<string[]>(refFilePath, []);
  const storeRoot = koishiMessageStoreDir(agentDir);
  return refs
    .map((relativePath) =>
      readJsonFile<StoredKoishiMessage | null>(
        path.join(storeRoot, relativePath),
        null,
      ),
    )
    .filter((item): item is StoredKoishiMessage =>
      Boolean(item && safeString(item.messageId).trim()),
    );
}

export function getKoishiMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  const recordKey = buildKoishiMessageRecordKey(chatKey, messageId);
  return readJsonFile<StoredKoishiMessage | null>(
    recordPath(agentDir, recordKey),
    null,
  );
}

export function updateKoishiMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
  patch: Partial<StoredKoishiMessage>,
) {
  const current = getKoishiMessage(agentDir, chatKey, messageId);
  if (!current) return null;
  const next: StoredKoishiMessage = {
    ...current,
    ...patch,
    version: 1,
    recordKey: current.recordKey,
    chatKey: current.chatKey,
    messageId: current.messageId,
    platform: current.platform,
    chatId: current.chatId,
  };
  writeJsonFile(recordPath(agentDir, current.recordKey), next);
  return next;
}

export function findKoishiMessageByChatAndId(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  const direct = getKoishiMessage(agentDir, chatKey, messageId);
  if (direct) return direct;
  return (
    getKoishiMessagesByMessageId(agentDir, messageId).find(
      (item) => item.chatKey === chatKey,
    ) || null
  );
}

export function normalizeKoishiMessageLookup(
  agentDir: string,
  messageId: string,
  chatKey?: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const matches = nextChatKey
    ? (() => {
        const found = findKoishiMessageByChatAndId(
          agentDir,
          nextChatKey,
          messageId,
        );
        return found ? [found] : [];
      })()
    : getKoishiMessagesByMessageId(agentDir, messageId);

  return matches.map((item) => ({
    ...item,
    parsedChatKey: parseChatKey(item.chatKey),
  }));
}

export function describeKoishiMessageRecord(record: StoredKoishiMessage) {
  return [
    `messageId=${record.messageId}`,
    `chatKey=${record.chatKey}`,
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

export function summarizeKoishiMessageRecord(record: StoredKoishiMessage) {
  return [
    `- message id: ${record.messageId}`,
    `- chatKey: ${record.chatKey}`,
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
