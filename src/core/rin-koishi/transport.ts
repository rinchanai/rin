import fs from "node:fs";
import path from "node:path";
import { pathToFileURL as toFileUrl } from "node:url";

import type { ImageContent } from "@mariozechner/pi-ai";

import type {
  ChatMessagePart,
  ChatOutboxPayload,
} from "../rin-lib/chat-outbox.js";
import { findBot, parseChatKey } from "./support.js";
import type { KoishiChatState, SavedAttachment } from "./chat-helpers.js";
import {
  ensureDir,
  extractTextFromContent,
  safeString,
} from "./chat-helpers.js";

export async function sendTyping(app: any, chatKey: string, h: any) {
  const parsed = parseChatKey(chatKey);
  if (!parsed || parsed.platform !== "telegram") return;
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot?.internal?.sendChatAction) return;
  try {
    await bot.internal.sendChatAction({
      chat_id: parsed.chatId,
      action: "typing",
    });
  } catch {}
}

export async function sendText(
  app: any,
  chatKey: string,
  text: string,
  h: any,
  replyToMessageId = "",
) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot)
    throw new Error(
      `no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ""}`,
    );
  const content = replyToMessageId ? [h.quote(replyToMessageId), text] : text;
  await bot.sendMessage(parsed.chatId, content);
}

export async function sendImageFile(
  app: any,
  chatKey: string,
  filePath: string,
  h: any,
  mimeType = "image/png",
  replyToMessageId = "",
) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot)
    throw new Error(
      `no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ""}`,
    );
  const buffer = await fs.promises.readFile(filePath);
  const content = replyToMessageId
    ? [h.quote(replyToMessageId), h.image(buffer, mimeType)]
    : [h.image(buffer, mimeType)];
  await bot.sendMessage(parsed.chatId, content);
}

export async function sendGenericFile(
  app: any,
  chatKey: string,
  filePath: string,
  h: any,
  name?: string,
  replyToMessageId = "",
) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot)
    throw new Error(
      `no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ""}`,
    );
  const fileNode = h("file", {
    src: toFileUrl(filePath).href,
    name: name || path.basename(filePath),
  });
  const content = replyToMessageId
    ? [h.quote(replyToMessageId), fileNode]
    : [fileNode];
  await bot.sendMessage(parsed.chatId, content);
}

export function messagePartToNode(part: ChatMessagePart, h: any) {
  if (part.type === "text") return part.text;
  if (part.type === "at")
    return h.at(part.id, part.name ? { name: part.name } : undefined);
  if (part.type === "image") {
    const src = safeString(part.path).trim()
      ? toFileUrl(path.resolve(part.path!)).href
      : safeString(part.url).trim();
    return h.image(src, safeString(part.mimeType).trim() || undefined);
  }
  const src = safeString(part.path).trim()
    ? toFileUrl(path.resolve(part.path!)).href
    : safeString(part.url).trim();
  return h.file(src, safeString(part.mimeType).trim() || undefined, {
    name:
      safeString(part.name).trim() ||
      (safeString(part.path).trim() ? path.basename(part.path!) : undefined),
  });
}

export function planTelegramDeliveries(parts: ChatMessagePart[]) {
  const normalized = Array.isArray(parts) ? parts.filter(Boolean) : [];
  const assetCount = normalized.filter(
    (part) => part.type === "image" || part.type === "file",
  ).length;
  const textLikeCount = normalized.filter(
    (part) => part.type === "text" || part.type === "at",
  ).length;
  if (assetCount <= 1 || !textLikeCount) return [normalized];

  const leadTextParts = normalized.filter(
    (part) => part.type === "text" || part.type === "at",
  );
  const assetBatches: ChatMessagePart[][] = [];
  let currentBatch: ChatMessagePart[] = [];
  let currentType = "";

  for (const part of normalized) {
    if (part.type !== "image" && part.type !== "file") continue;
    if (currentBatch.length && currentType !== part.type) {
      assetBatches.push(currentBatch);
      currentBatch = [];
    }
    currentType = part.type;
    currentBatch.push(part);
  }
  if (currentBatch.length) assetBatches.push(currentBatch);

  if (!leadTextParts.length || !assetBatches.length) return [normalized];
  return [leadTextParts, ...assetBatches];
}

export async function sendOutboxPayload(
  app: any,
  payload: ChatOutboxPayload,
  h: any,
) {
  if (payload?.type === "text_delivery") {
    await sendText(
      app,
      safeString(payload.chatKey).trim(),
      safeString(payload.text).trim(),
      h,
      safeString(payload.replyToMessageId).trim(),
    );
    return;
  }
  if (payload?.type !== "parts_delivery") return;
  const chatKey = safeString(payload.chatKey).trim();
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot)
    throw new Error(
      `no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ""}`,
    );

  const rawParts = Array.isArray(payload.parts) ? payload.parts : [];
  const plannedBatches =
    parsed.platform === "telegram"
      ? planTelegramDeliveries(rawParts)
      : [rawParts];
  if (!plannedBatches.length) throw new Error("koishi_outbox_empty_message");

  let nextReplyToMessageId = safeString(payload.replyToMessageId).trim();
  for (const batch of plannedBatches) {
    const nodes = batch
      .map((part) => messagePartToNode(part, h))
      .filter(Boolean);
    if (!nodes.length) continue;
    const content = nextReplyToMessageId
      ? [h.quote(nextReplyToMessageId), ...nodes]
      : nodes;
    await bot.sendMessage(parsed.chatId, content);
    nextReplyToMessageId = "";
  }
}

export function buildPromptText(text: string, attachments: SavedAttachment[]) {
  const files = attachments.filter((item) => item.kind === "file");
  if (!files.length) return text;
  const lines = files.map((item) => `- ${item.name}: ${item.path}`);
  return `${text}\n\nAttached files saved locally:\n${lines.join("\n")}`;
}

export async function attachmentToImageContent(
  filePath: string,
  mimeType = "image/png",
): Promise<ImageContent> {
  const data = await fs.promises.readFile(filePath);
  return { type: "image", data: data.toString("base64"), mimeType };
}

export async function restorePromptParts(
  processing: NonNullable<KoishiChatState["processing"]>,
) {
  const attachments = (processing.attachments || []).filter(
    (item) => item && fs.existsSync(item.path),
  );
  const images = await Promise.all(
    attachments
      .filter((item) => item.kind === "image")
      .map((item) =>
        attachmentToImageContent(item.path, item.mimeType || "image/png"),
      ),
  );
  const text = buildPromptText(processing.text, attachments);
  return { text, images, attachments };
}
