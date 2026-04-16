import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { writeJsonAtomic } from "../platform/fs.js";
import { readJsonFile } from "./support.js";

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

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

function serializeSession(session: any) {
  return {
    platform: safeString(session?.platform).trim() || undefined,
    selfId: safeString(session?.selfId || session?.bot?.selfId).trim() || undefined,
    channelId: safeString(session?.channelId).trim() || undefined,
    guildId: safeString(session?.guildId).trim() || undefined,
    userId: safeString(session?.userId || session?.author?.userId).trim() || undefined,
    messageId: safeString(session?.messageId).trim() || undefined,
    timestamp:
      Number.isFinite(Number(session?.timestamp)) ? Number(session.timestamp) : undefined,
    content: safeString(session?.content).trim() || undefined,
    stripped:
      session?.stripped && typeof session.stripped === "object"
        ? { content: safeString(session.stripped.content).trim() || undefined }
        : undefined,
    isDirect: Boolean(session?.isDirect),
    username: safeString(session?.username).trim() || undefined,
    author:
      session?.author && typeof session.author === "object"
        ? JSON.parse(JSON.stringify(session.author))
        : undefined,
    user:
      session?.user && typeof session.user === "object"
        ? JSON.parse(JSON.stringify(session.user))
        : undefined,
    channel:
      session?.channel && typeof session.channel === "object"
        ? JSON.parse(JSON.stringify(session.channel))
        : undefined,
    guild:
      session?.guild && typeof session.guild === "object"
        ? JSON.parse(JSON.stringify(session.guild))
        : undefined,
    quote:
      session?.quote && typeof session.quote === "object"
        ? JSON.parse(JSON.stringify(session.quote))
        : undefined,
  };
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
    session: serializeSession(input.session),
    elements: Array.isArray(input.elements)
      ? JSON.parse(JSON.stringify(input.elements))
      : [],
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

export function listPendingChatInboxFiles(agentDir: string) {
  try {
    return fs
      .readdirSync(pendingDir(agentDir))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(pendingDir(agentDir), name));
  } catch {
    return [] as string[];
  }
}

export function readChatInboxItem(filePath: string) {
  return readJsonFile<ChatInboxItem | null>(filePath, null);
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
