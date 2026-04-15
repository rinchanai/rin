import fs from "node:fs";
import path from "node:path";

import {
  composeChatKey,
  ensureExtension,
  ensureFileName,
  fileNameFromUrl,
} from "./support.js";
import {
  findKoishiMessageByChatAndId,
  normalizeElementSummary,
  saveKoishiMessage,
  updateKoishiMessage,
} from "./message-store.js";

export type SavedAttachment = {
  kind: "image" | "file";
  path: string;
  name: string;
  mimeType?: string;
};

export type InboundAttachmentFailure = {
  type: string;
  kind: "image" | "file";
  reason: "unresolved_resource" | "fetch_failed";
  resource?: string;
  detail?: string;
};

export type KoishiChatState = {
  chatKey: string;
  piSessionFile?: string;
  processing?: {
    text: string;
    attachments: SavedAttachment[];
    startedAt: number;
    replyToMessageId?: string;
  };
  pendingDelivery?: {
    type: "text_delivery";
    chatKey: string;
    text: string;
    replyToMessageId?: string;
    sessionId?: string;
    sessionFile?: string;
  };
};

export type KoishiBridgePromptMeta = {
  source: "koishi-bridge";
  sentAt?: number;
  chatKey?: string;
  chatName?: string;
  chatType?: "private" | "group";
  userId?: string;
  nickname?: string;
  identity?: string;
  replyToMessageId?: string;
  attachedFiles?: Array<{ name?: string; path?: string }>;
};

export function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function listJsonFiles(dir: string) {
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

export function pickUserId(session: any) {
  return safeString(session?.userId || session?.author?.userId || "").trim();
}

export function directLike(session: any) {
  return (
    Boolean(session?.isDirect) ||
    !safeString(session?.guildId || "").trim() ||
    safeString(session?.channelId || "").startsWith("private:")
  );
}

function normalizeMentionToken(value: unknown) {
  return safeString(value).trim().replace(/^@+/, "").toLowerCase();
}

export function mentionLike(session: any) {
  if (Boolean(session?.stripped?.appel)) return true;
  const elements = ensureSessionElements(session);
  const atElements = elements.filter(
    (element) => safeString(element?.type).toLowerCase() === "at",
  );
  if (!atElements.length) return false;

  const selfTokens = new Set(
    [
      session?.selfId,
      session?.bot?.selfId,
      session?.username,
      session?.user?.username,
      session?.bot?.username,
      session?.bot?.name,
      session?.bot?.user?.name,
      session?.bot?.user?.username,
      session?.bot?.nick,
      session?.bot?.user?.nick,
    ]
      .map(normalizeMentionToken)
      .filter(Boolean),
  );

  for (const element of atElements) {
    const attrs = element?.attrs || {};
    const id = normalizeMentionToken(attrs.id);
    const name = normalizeMentionToken(attrs.name);
    if ((id && selfTokens.has(id)) || (name && selfTokens.has(name))) {
      return true;
    }
  }

  return false;
}

export function ensureSessionElements(session: any) {
  if (Array.isArray(session?.elements) && session.elements.length) {
    return session.elements;
  }
  const stripped = safeString(session?.stripped?.content || "").trim();
  if (stripped) return [{ type: "text", attrs: { content: stripped } }];
  const raw = safeString(session?.content || "").trim();
  if (raw) return [{ type: "text", attrs: { content: raw } }];
  return [] as any[];
}

function collectIncomingElementText(element: any): string {
  if (!element) return "";
  if (typeof element === "string") return element;
  if (Array.isArray(element))
    return element.map((item) => collectIncomingElementText(item)).join("");
  if (typeof element !== "object") return "";
  const type = safeString(element?.type || "").toLowerCase();
  const attrs =
    element?.attrs && typeof element.attrs === "object" ? element.attrs : {};
  if (type === "text") return safeString(attrs.content || element.text || "");
  if (type === "br") return "\n";
  const children = Array.isArray(element?.children) ? element.children : [];
  const childText = children.map((item) => collectIncomingElementText(item)).join("");
  if (type === "p" || type === "paragraph") return childText ? `${childText}\n` : "";
  return childText;
}

function normalizeIncomingText(text: string) {
  return safeString(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function elementsToText(elements: any) {
  return normalizeIncomingText(
    (Array.isArray(elements) ? elements : [])
      .map((element) => collectIncomingElementText(element))
      .join(""),
  );
}

export function pickSenderNickname(session: any) {
  const values = [
    session?.author?.nick,
    session?.author?.name,
    session?.author?.nickname,
    session?.author?.username,
    session?.username,
    session?.user?.nick,
    session?.user?.name,
    session?.user?.nickname,
    session?.user?.username,
  ];
  for (const value of values) {
    const text = safeString(value).trim();
    if (text) return text;
  }
  return "";
}

export function pickChatName(session: any) {
  const values = [
    session?.channel?.name,
    session?.channelName,
    session?.guild?.name,
    session?.guildName,
  ];
  for (const value of values) {
    const text = safeString(value).trim();
    if (text) return text;
  }
  return "";
}

export function pickMessageId(session: any) {
  return safeString(session?.messageId || "").trim();
}

export function pickReplyToMessageId(session: any) {
  return safeString(session?.quote?.messageId || session?.quote?.id || "").trim();
}

export function summarizeQuote(session: any) {
  const quote = session?.quote;
  if (!quote || typeof quote !== "object") return undefined;
  const messageId =
    safeString(quote?.messageId || quote?.id || "").trim() || undefined;
  const userId =
    safeString(
      quote?.user?.id || quote?.author?.userId || quote?.author?.id || "",
    ).trim() || undefined;
  const nickname =
    safeString(
      quote?.user?.name || quote?.author?.name || quote?.author?.nick || "",
    ).trim() || undefined;
  const content =
    safeString(quote?.content || quote?.message?.content || "").trim() ||
    undefined;
  if (!messageId && !userId && !nickname && !content) return undefined;
  return { messageId, userId, nickname, content };
}

export function hasMediaElements(elements: any[]) {
  if (!Array.isArray(elements) || !elements.length) return false;
  return elements.some((element) => {
    const type = safeString(element?.type || "").toLowerCase();
    return type === "img" || type === "image" || type === "file";
  });
}

export function getChatId(session: any) {
  const channelId = safeString(session?.channelId || "").trim();
  if (channelId) return channelId;
  const userId = pickUserId(session);
  if (!userId) return "";
  return safeString(session?.platform) === "onebot"
    ? `private:${userId}`
    : userId;
}

export function getChatType(session: any): "private" | "group" {
  return directLike(session) ? "private" : "group";
}

export function extractTextFromContent(
  content: any,
  { includeThinking = false }: { includeThinking?: boolean } = {},
) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return safeString(part.text);
      if (includeThinking && part.type === "thinking")
        return safeString(part.thinking);
      return "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

export function extractImageParts(content: any) {
  if (!Array.isArray(content))
    return [] as Array<{ data: string; mimeType: string }>;
  const out: Array<{ data: string; mimeType: string }> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type !== "image") continue;
    const data = safeString((part as any).data || "");
    const mimeType =
      safeString((part as any).mimeType || "").trim() || "image/png";
    if (!data) continue;
    out.push({ data, mimeType });
  }
  return out;
}

export function extractExistingFilePaths(text: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const pattern = /file:\/\/(\/[^\s'"`<>]+)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = safeString(match[1] || "").trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (seen.has(resolved)) continue;
    if (!fs.existsSync(resolved)) continue;
    if (!fs.statSync(resolved).isFile()) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out.slice(0, 8);
}

export function persistInboundMessage(
  agentDir: string,
  session: any,
  elements: any[],
  identity: any,
  trustOf: (identity: any, platform: string, userId: string) => string,
) {
  const platform = safeString(session?.platform || "").trim();
  const botId = safeString(
    session?.selfId || session?.bot?.selfId || "",
  ).trim();
  const chatId = getChatId(session);
  const chatKey = composeChatKey(platform, chatId, botId);
  const messageId = pickMessageId(session);
  if (!chatKey || !messageId) return null;
  const userId = pickUserId(session);
  return saveKoishiMessage(agentDir, {
    messageId,
    role: "user",
    replyToMessageId: pickReplyToMessageId(session) || undefined,
    chatKey,
    platform,
    botId: botId || undefined,
    chatId,
    chatType: getChatType(session),
    receivedAt: new Date().toISOString(),
    platformTimestamp: Number.isFinite(Number(session?.timestamp))
      ? Number(session.timestamp)
      : undefined,
    userId: userId || undefined,
    nickname: pickSenderNickname(session) || undefined,
    chatName: pickChatName(session) || undefined,
    trust: trustOf(identity, platform, userId),
    text: elementsToText(elements) || undefined,
    rawContent: safeString(session?.content || "").trim() || undefined,
    strippedContent:
      safeString(session?.stripped?.content || "").trim() || undefined,
    elements: normalizeElementSummary(elements),
    quote: summarizeQuote(session),
  });
}

export function lookupReplyMessage(
  agentDir: string,
  chatKey: string,
  replyToMessageId: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextReplyToMessageId = safeString(replyToMessageId).trim();
  if (!nextChatKey || !nextReplyToMessageId) return null;
  return (
    findKoishiMessageByChatAndId(agentDir, nextChatKey, nextReplyToMessageId) ||
    null
  );
}

export function lookupReplySession(
  agentDir: string,
  chatKey: string,
  replyToMessageId: string,
) {
  const linked = lookupReplyMessage(agentDir, chatKey, replyToMessageId);
  const sessionId = safeString(linked?.sessionId || "").trim();
  const sessionFile = safeString(linked?.sessionFile || "").trim();
  if (!linked) return null;
  return {
    linked,
    sessionId: sessionId || undefined,
    sessionFile: sessionFile || undefined,
  };
}

export function markProcessedKoishiMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
  update: Record<string, unknown>,
) {
  updateKoishiMessage(agentDir, chatKey, messageId, update);
}

export async function persistImageParts(
  chatDir: string,
  images: Array<{ data: string; mimeType: string }>,
  prefix: string,
) {
  const dir = path.join(chatDir, "outbound");
  ensureDir(dir);
  const out: SavedAttachment[] = [];
  let index = 0;
  for (const image of images) {
    index += 1;
    const fileName = ensureExtension(`${prefix}-${index}`, image.mimeType);
    const filePath = path.join(dir, fileName);
    await fs.promises.writeFile(filePath, Buffer.from(image.data, "base64"));
    out.push({
      kind: "image",
      path: filePath,
      name: fileName,
      mimeType: image.mimeType,
    });
  }
  return out;
}

function mediaKindFromElementType(type: string) {
  return type === "img" || type === "image"
    ? "image"
    : type === "file"
      ? "file"
      : "";
}

export function buildInboundAttachmentNotice(
  failures: InboundAttachmentFailure[],
) {
  if (!Array.isArray(failures) || !failures.length) return "";
  const unresolved = failures.filter(
    (item) => item.reason === "unresolved_resource",
  ).length;
  const fetchFailed = failures.filter((item) => item.reason === "fetch_failed").length;
  const parts: string[] = [];
  if (unresolved)
    parts.push(
      `${unresolved} media element${unresolved === 1 ? " was" : "s were"} present, but the chat bridge runtime did not resolve a downloadable resource`,
    );
  if (fetchFailed)
    parts.push(
      `${fetchFailed} media resource${fetchFailed === 1 ? "" : "s"} could not be fetched`,
    );
  return `Note: the incoming message included media that could not be attached for the agent because ${parts.join(" and ")}.`;
}

export async function extractInboundAttachments(elements: any[], chatDir: string) {
  const dir = path.join(chatDir, "inbound");
  ensureDir(dir);
  const attachments: SavedAttachment[] = [];
  const failures: InboundAttachmentFailure[] = [];
  let index = 0;

  for (const element of elements) {
    const type = safeString(element?.type || "").toLowerCase();
    const attrs =
      element?.attrs && typeof element.attrs === "object" ? element.attrs : {};
    const kind = mediaKindFromElementType(type);
    if (!kind) continue;
    const src = safeString(attrs.src || attrs.url || attrs.file || "").trim();
    if (!src) {
      failures.push({
        type: type || "unknown",
        kind: kind as "image" | "file",
        reason: "unresolved_resource",
      });
      continue;
    }

    index += 1;
    let response: Response;
    try {
      response = await fetch(src);
    } catch (error: any) {
      failures.push({
        type: type || "unknown",
        kind: kind as "image" | "file",
        reason: "fetch_failed",
        resource: src,
        detail: safeString(error?.message || error).trim() || undefined,
      });
      continue;
    }
    if (!response.ok) {
      failures.push({
        type: type || "unknown",
        kind: kind as "image" | "file",
        reason: "fetch_failed",
        resource: src,
        detail: `http_${response.status}`,
      });
      continue;
    }
    const arrayBuffer = await response.arrayBuffer();
    const mimeType = safeString(
      response.headers.get("content-type") || attrs.mime || "",
    )
      .split(";", 1)[0]
      .trim();
    const rawName =
      safeString(
        attrs.file ||
          attrs.title ||
          attrs.name ||
          fileNameFromUrl(src, `${kind}-${index}`),
      ).trim() || `${kind}-${index}`;
    const fileName = ensureExtension(
      ensureFileName(rawName, `${kind}-${index}`),
      mimeType,
    );
    const filePath = path.join(dir, `${Date.now()}-${index}-${fileName}`);
    await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
    attachments.push({
      kind: kind as "image" | "file",
      path: filePath,
      name: fileName,
      mimeType,
    });
  }

  return { attachments, failures };
}
