import fs from "node:fs";
import path from "node:path";

import { normalizeLocalDateOnly } from "./date.js";
import { parseChatKey } from "./support.js";
import { safeString } from "../text-utils.js";

export type ChatMessageStoreRoot = {
  storeDir: string;
  recordsDir: string;
  indexesDir: string;
  logDir: string;
};

export type ChatMessageStoreLayout = {
  preferredStoreDir: string;
  legacyStoreDir: string;
  storeDir: string;
  fallbackStoreDir?: string;
  recordsDir: string;
  indexesDir: string;
  logDir: string;
  primaryRoot: ChatMessageStoreRoot;
  fallbackRoot?: ChatMessageStoreRoot;
  readRoots: ChatMessageStoreRoot[];
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

function buildChatMessageStoreRoot(storeDir: string): ChatMessageStoreRoot {
  return {
    storeDir,
    recordsDir: recordsDirForStoreDir(storeDir),
    indexesDir: indexesDirForStoreDir(storeDir),
    logDir: path.join(storeDir, "chat-log-view"),
  };
}

function dedupeStoreRoots(values: Array<ChatMessageStoreRoot | undefined>) {
  const out: ChatMessageStoreRoot[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const storeDir = safeString(value?.storeDir).trim();
    if (!storeDir || seen.has(storeDir) || !value) continue;
    seen.add(storeDir);
    out.push(value);
  }
  return out;
}

function buildChatMessageStoreLayout(
  preferredStoreDir: string,
  legacyStoreDir: string,
  storeDir: string,
  fallbackStoreDir: string | undefined,
  source: ChatMessageStoreLayout["source"],
): ChatMessageStoreLayout {
  const primaryRoot = buildChatMessageStoreRoot(storeDir);
  const fallbackRoot = fallbackStoreDir
    ? buildChatMessageStoreRoot(fallbackStoreDir)
    : undefined;
  return {
    preferredStoreDir,
    legacyStoreDir,
    storeDir,
    fallbackStoreDir,
    recordsDir: primaryRoot.recordsDir,
    indexesDir: primaryRoot.indexesDir,
    logDir: primaryRoot.logDir,
    primaryRoot,
    fallbackRoot,
    readRoots: dedupeStoreRoots([primaryRoot, fallbackRoot]),
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

export function chatMessageStoreRoots(agentDir: string) {
  return getChatMessageStoreLayout(agentDir).readRoots.map(
    (root) => root.storeDir,
  );
}

export function recordRoots(agentDir: string) {
  return getChatMessageStoreLayout(agentDir).readRoots.map(
    (root) => root.recordsDir,
  );
}

export function indexRoots(agentDir: string) {
  return getChatMessageStoreLayout(agentDir).readRoots.map(
    (root) => root.indexesDir,
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
