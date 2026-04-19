import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { cloneJson, cloneJsonIfObject } from "../json-utils.js";
import { writeJsonAtomic } from "../platform/fs.js";
import {
  buildChatInboxRouting,
  serializeChatInboxSession,
} from "./inbound-normalization.js";
import { readJsonFile } from "./support.js";
import { safeString } from "../text-utils.js";

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

export type ChatInboxItemRouting = {
  chatType: "private" | "group";
  isDirect: boolean;
  mentionLike: boolean;
  text?: string;
  userId?: string;
  nickname?: string;
  chatName?: string;
  replyToMessageId?: string;
};

export type ChatInboxItem = {
  version: 1;
  itemId: string;
  chatKey: string;
  messageId: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  nextAttemptAt?: string;
  lastError?: string;
  routing: ChatInboxItemRouting;
  session: Record<string, unknown>;
  elements: any[];
};

export function chatInboxDir(agentDir: string) {
  return path.join(path.resolve(agentDir), "data", "chat-inbox");
}

function pendingDir(agentDir: string) {
  return path.join(chatInboxDir(agentDir), "pending");
}

function processingDir(agentDir: string) {
  return path.join(chatInboxDir(agentDir), "processing");
}

function failedDir(agentDir: string) {
  return path.join(chatInboxDir(agentDir), "failed");
}

function itemFileName(itemId: string) {
  return `${itemId}.json`;
}

export function buildChatInboxItem(input: {
  chatKey: string;
  messageId: string;
  session: any;
  elements: any[];
}) {
  const chatKey = safeString(input.chatKey).trim();
  const messageId = safeString(input.messageId).trim();
  if (!chatKey) throw new Error("chat_inbox_chatKey_required");
  if (!messageId) throw new Error("chat_inbox_messageId_required");
  const now = new Date().toISOString();
  return {
    version: 1 as const,
    itemId: hashKey(`${chatKey}\n${messageId}`),
    chatKey,
    messageId,
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    routing: buildChatInboxRouting(input.session, input.elements),
    session: serializeChatInboxSession(input.session),
    elements: Array.isArray(input.elements) ? cloneJson(input.elements) : [],
  } satisfies ChatInboxItem;
}

export function enqueueChatInboxItem(
  agentDir: string,
  input: { chatKey: string; messageId: string; session: any; elements: any[] },
) {
  const item = buildChatInboxItem(input);
  const filePath = path.join(pendingDir(agentDir), itemFileName(item.itemId));
  writeJsonAtomic(filePath, item);
  return { item, filePath };
}

function listInboxFiles(dir: string) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [] as string[];
  }
}

export function listPendingChatInboxFiles(agentDir: string) {
  return listInboxFiles(pendingDir(agentDir));
}

export function listProcessingChatInboxFiles(agentDir: string) {
  return listInboxFiles(processingDir(agentDir));
}

export function readChatInboxItem(filePath: string) {
  return readJsonFile<ChatInboxItem | null>(filePath, null);
}

export function restoreChatInboxSession(item: ChatInboxItem, bot?: any) {
  const session = (cloneJsonIfObject(item?.session) ?? {}) as Record<
    string,
    any
  >;
  const routing =
    item?.routing && typeof item.routing === "object" ? item.routing : null;
  if (bot) session.bot = bot;
  if (routing) {
    session.isDirect = Boolean(routing.isDirect);
    session.userId = safeString(session.userId || routing.userId).trim() || undefined;
    if (routing.text) {
      session.stripped = {
        ...(session?.stripped && typeof session.stripped === "object"
          ? session.stripped
          : {}),
        content: safeString(session?.stripped?.content || routing.text).trim() || undefined,
        appel: Boolean(routing.mentionLike) || undefined,
      };
    } else if (routing.mentionLike) {
      session.stripped = {
        ...(session?.stripped && typeof session.stripped === "object"
          ? session.stripped
          : {}),
        appel: true,
      };
    }
    if (routing.replyToMessageId) {
      session.quote = {
        ...(session?.quote && typeof session.quote === "object"
          ? session.quote
          : {}),
        messageId:
          safeString(session?.quote?.messageId || routing.replyToMessageId).trim() ||
          undefined,
      };
    }
    if (routing.nickname) {
      session.author = {
        ...(session?.author && typeof session.author === "object"
          ? session.author
          : {}),
        name: safeString(session?.author?.name || routing.nickname).trim() || undefined,
      };
    }
    if (routing.chatName) {
      session.channelName =
        safeString(session?.channelName || routing.chatName).trim() || undefined;
    }
  }
  return session;
}

export function claimChatInboxFile(agentDir: string, filePath: string) {
  try {
    fs.mkdirSync(processingDir(agentDir), { recursive: true });
    const claimedPath = path.join(processingDir(agentDir), path.basename(filePath));
    fs.renameSync(filePath, claimedPath);
    return claimedPath;
  } catch {
    return "";
  }
}

export function completeChatInboxFile(filePath: string) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

export function restoreChatInboxFile(
  agentDir: string,
  filePath: string,
  item: ChatInboxItem,
) {
  const targetPath = path.join(pendingDir(agentDir), itemFileName(item.itemId));
  writeJsonAtomic(targetPath, item);
  completeChatInboxFile(filePath);
  return { item, filePath: targetPath };
}

export function requeueChatInboxFile(
  agentDir: string,
  filePath: string,
  item: ChatInboxItem,
  options: { delayMs: number; error?: string },
) {
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  const next: ChatInboxItem = {
    ...item,
    attemptCount: Number(item.attemptCount || 0) + 1,
    updatedAt: new Date().toISOString(),
    nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
    lastError: safeString(options.error).trim() || undefined,
  };
  const targetPath = path.join(pendingDir(agentDir), itemFileName(next.itemId));
  writeJsonAtomic(targetPath, next);
  completeChatInboxFile(filePath);
  return { item: next, filePath: targetPath };
}

export function failChatInboxFile(
  agentDir: string,
  filePath: string,
  item: ChatInboxItem,
  error?: string,
) {
  const next: ChatInboxItem = {
    ...item,
    attemptCount: Number(item.attemptCount || 0) + 1,
    updatedAt: new Date().toISOString(),
    lastError: safeString(error).trim() || undefined,
  };
  const targetPath = path.join(failedDir(agentDir), itemFileName(next.itemId));
  writeJsonAtomic(targetPath, next);
  completeChatInboxFile(filePath);
  return { item: next, filePath: targetPath };
}

export function restoreProcessingChatInboxFiles(agentDir: string) {
  const restored: Array<{ itemId: string; filePath: string }> = [];
  for (const filePath of listProcessingChatInboxFiles(agentDir)) {
    const item = readChatInboxItem(filePath);
    if (!item) {
      completeChatInboxFile(filePath);
      continue;
    }
    const next = restoreChatInboxFile(agentDir, filePath, item);
    restored.push({ itemId: item.itemId, filePath: next.filePath });
  }
  return restored;
}
