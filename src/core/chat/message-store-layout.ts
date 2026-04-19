import fs from "node:fs";
import path from "node:path";

import { normalizeLocalDateOnly } from "./date.js";
import { parseChatKey } from "./support.js";
import { safeString } from "../text-utils.js";

export type ChatMessageStoreLayout = {
  preferredStoreDir: string;
  legacyStoreDir: string;
  storeDir: string;
  fallbackStoreDir?: string;
  recordsDir: string;
  indexesDir: string;
  logDir: string;
  source: "preferred" | "legacy" | "implicit-preferred";
};

export function sanitizePathSegment(value: string, fallback: string) {
  const text = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_");
  return text || fallback;
}

export function recordsDirForStoreDir(storeDir: string) {
  return path.join(storeDir, "records");
}

export function indexesDirForStoreDir(storeDir: string) {
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

export function getChatMessageStoreLayout(agentDir: string) {
  return detectChatMessageStoreLayout(path.resolve(agentDir));
}

function dedupeStoreDirs(values: Array<string | undefined>) {
  return [
    ...new Set(values.map((item) => safeString(item).trim()).filter(Boolean)),
  ];
}

export function chatMessageStoreRoots(agentDir: string) {
  const layout = getChatMessageStoreLayout(agentDir);
  return dedupeStoreDirs([layout.storeDir, layout.fallbackStoreDir]);
}

export function recordRoots(agentDir: string) {
  return chatMessageStoreRoots(agentDir).map((storeDir) =>
    recordsDirForStoreDir(storeDir),
  );
}

export function indexRoots(agentDir: string) {
  return chatMessageStoreRoots(agentDir).map((storeDir) =>
    indexesDirForStoreDir(storeDir),
  );
}

export function chatScopedDatePath(
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
