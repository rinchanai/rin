import fs from "node:fs";
import path from "node:path";
import { pathToFileURL as toFileUrl } from "node:url";

import type { ImageContent } from "@mariozechner/pi-ai";

import type {
  ChatMessagePart,
  ChatOutboxPayload,
} from "../rin-lib/chat-outbox.js";
import { findBot, parseChatKey } from "./support.js";
import { appendKoishiChatLog } from "./chat-log.js";
import {
  findKoishiMessageByChatAndId,
  saveKoishiMessage,
} from "./message-store.js";
import type { KoishiChatState, SavedAttachment } from "./chat-helpers.js";
import {
  ensureDir,
  extractTextFromContent,
  safeString,
} from "./chat-helpers.js";

const DEFAULT_WORKING_REACTION_FRAMES = ["🌘"] as const;
const ONEBOT_WORKING_REACTION_FRAMES = ["👍"] as const;

export function getWorkingReactionFrame(platform: string, index: number) {
  const frames =
    safeString(platform).trim() === "onebot"
      ? ONEBOT_WORKING_REACTION_FRAMES
      : DEFAULT_WORKING_REACTION_FRAMES;
  const size = frames.length;
  if (!size) return "🌕";
  const nextIndex = Number.isFinite(index)
    ? Math.abs(Math.floor(index)) % size
    : 0;
  return frames[nextIndex] || frames[0];
}

export async function sendTyping(app: any, chatKey: string, h: any) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) return false;
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot) return false;
  if (typeof bot?.internal?.sendChatAction === "function") {
    try {
      await bot.internal.sendChatAction({
        chat_id: parsed.chatId,
        action: "typing",
      });
      return true;
    } catch {}
  }
  if (typeof bot?.internal?.sendTyping === "function") {
    try {
      await bot.internal.sendTyping(parsed.chatId);
      return true;
    } catch {}
  }
  return false;
}

export async function rotateWorkingReaction(
  app: any,
  chatKey: string,
  messageId: string,
  frameIndex: number,
  previousEmoji = "",
) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) return previousEmoji || "";
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot) return previousEmoji || "";
  const nextEmoji = getWorkingReactionFrame(parsed.platform, frameIndex);
  if (previousEmoji && previousEmoji === nextEmoji) {
    return previousEmoji;
  }

  if (
    parsed.platform !== "onebot" &&
    typeof bot?.internal?.setMessageReaction === "function"
  ) {
    try {
      await bot.internal.setMessageReaction({
        chat_id: parsed.chatId,
        message_id: Number(messageId),
        reaction: [{ type: "emoji", emoji: nextEmoji }],
      });
      return nextEmoji;
    } catch {
      return previousEmoji || "";
    }
  }

  if (typeof bot?.createReaction !== "function") {
    return previousEmoji || "";
  }
  if (previousEmoji && previousEmoji !== nextEmoji) {
    if (typeof bot?.deleteReaction !== "function") {
      return previousEmoji || "";
    }
    try {
      await bot.deleteReaction(
        parsed.chatId,
        messageId,
        previousEmoji,
        safeString(bot?.selfId).trim() || undefined,
      );
    } catch {}
  }
  try {
    await bot.createReaction(parsed.chatId, messageId, nextEmoji);
    return nextEmoji;
  } catch {
    return previousEmoji || "";
  }
}

export async function clearWorkingReaction(
  app: any,
  chatKey: string,
  messageId: string,
  emoji: string,
) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) return false;
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot) return false;
  const nextEmoji = safeString(emoji).trim();
  if (!nextEmoji) return false;

  if (typeof bot?.deleteReaction === "function") {
    try {
      await bot.deleteReaction(
        parsed.chatId,
        messageId,
        nextEmoji,
        safeString(bot?.selfId).trim() || undefined,
      );
      return true;
    } catch {}
  }

  if (
    parsed.platform !== "onebot" &&
    typeof bot?.internal?.setMessageReaction === "function"
  ) {
    try {
      await bot.internal.setMessageReaction({
        chat_id: parsed.chatId,
        message_id: Number(messageId),
        reaction: [],
      });
      return true;
    } catch {
      return false;
    }
  }

  if (typeof bot?.deleteReaction !== "function") return false;
  try {
    await bot.deleteReaction(
      parsed.chatId,
      messageId,
      nextEmoji,
      safeString(bot?.selfId).trim() || undefined,
    );
    return true;
  } catch {
    return false;
  }
}

function normalizeDeliveredMessageIds(result: unknown) {
  if (!Array.isArray(result) || !result.length) {
    throw new Error("chat_send_message_empty_result");
  }
  const messageIds = result
    .map((item) => safeString(item).trim())
    .filter(Boolean);
  if (!messageIds.length) {
    throw new Error("chat_send_message_empty_result");
  }
  return messageIds;
}

async function sendBotMessage(bot: any, chatId: string, content: any) {
  return normalizeDeliveredMessageIds(await bot.sendMessage(chatId, content));
}

function inferChatType(parsed: { platform: string; chatId: string }) {
  if (parsed.platform === "telegram")
    return parsed.chatId.startsWith("-") ? "group" : "private";
  if (parsed.chatId.startsWith("private:")) return "private";
  return "group";
}

function resolveSessionContext(
  agentDir: string,
  chatKey: string,
  replyToMessageId = "",
  explicit: { sessionId?: string; sessionFile?: string } = {},
) {
  const sessionId = safeString(explicit.sessionId).trim();
  const sessionFile = safeString(explicit.sessionFile).trim();
  if (sessionId || sessionFile) {
    return {
      sessionId: sessionId || undefined,
      sessionFile: sessionFile || undefined,
    };
  }
  const nextReplyToMessageId = safeString(replyToMessageId).trim();
  if (!nextReplyToMessageId) return {};
  const linked = findKoishiMessageByChatAndId(
    agentDir,
    chatKey,
    nextReplyToMessageId,
  );
  return {
    sessionId: safeString(linked?.sessionId).trim() || undefined,
    sessionFile: safeString(linked?.sessionFile).trim() || undefined,
  };
}

export function recordDeliveredAssistantMessages(
  agentDir: string,
  input: {
    chatKey: string;
    deliveryResult: string[];
    text?: string;
    rawContent?: string;
    replyToMessageId?: string;
    sessionId?: string;
    sessionFile?: string;
  },
) {
  const chatKey = safeString(input.chatKey).trim();
  if (!chatKey) return [] as string[];
  const parsed = parseChatKey(chatKey);
  if (!parsed) return [] as string[];
  const messageIds = Array.isArray(input.deliveryResult)
    ? input.deliveryResult
        .map((item) => safeString(item).trim())
        .filter(Boolean)
    : [];
  if (!messageIds.length) return [] as string[];

  const bodyText = safeString(input.text).trim();
  const rawContent =
    safeString(input.rawContent).trim() || bodyText || undefined;
  const session = resolveSessionContext(
    agentDir,
    chatKey,
    safeString(input.replyToMessageId).trim(),
    {
      sessionId: input.sessionId,
      sessionFile: input.sessionFile,
    },
  );
  const now = new Date().toISOString();

  for (const messageId of messageIds) {
    saveKoishiMessage(agentDir, {
      messageId,
      role: "assistant",
      replyToMessageId: safeString(input.replyToMessageId).trim() || undefined,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      processedAt: now,
      chatKey,
      platform: parsed.platform,
      botId: parsed.botId || undefined,
      chatId: parsed.chatId,
      chatType: inferChatType(parsed),
      receivedAt: now,
      text: bodyText || undefined,
      rawContent,
      strippedContent: bodyText || undefined,
    });
  }

  return messageIds;
}

function localAssetUrl(filePath: string) {
  return toFileUrl(path.resolve(filePath)).href;
}

function summarizeOutgoingParts(parts: ChatMessagePart[]) {
  return parts
    .map((part) => {
      if (part.type === "text") return safeString(part.text).trim();
      if (part.type === "at")
        return `[@] ${safeString(part.name).trim() || safeString(part.id).trim()}`;
      if (part.type === "quote")
        return `[#quote] ${safeString(part.id).trim()}`;
      if (part.type === "image")
        return `[#image] ${safeString(part.path).trim() || safeString(part.url).trim()}`;
      return `[#file] ${safeString(part.name).trim() || safeString(part.path).trim() || safeString(part.url).trim()}`;
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
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
  const textNode = h.text(safeString(text));
  const content = replyToMessageId
    ? [h.quote(replyToMessageId), textNode]
    : [textNode];
  return await sendBotMessage(bot, parsed.chatId, content);
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
  const imageNode = h("image", {
    src: localAssetUrl(filePath),
    mimeType,
  });
  const content = replyToMessageId
    ? [h.quote(replyToMessageId), imageNode]
    : [imageNode];
  return await sendBotMessage(bot, parsed.chatId, content);
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
  return await sendBotMessage(bot, parsed.chatId, content);
}

export async function messagePartToNode(part: ChatMessagePart, h: any) {
  if (part.type === "text") return h.text(part.text);
  if (part.type === "at")
    return h.at(part.id, part.name ? { name: part.name } : undefined);
  if (part.type === "quote") return h.quote(part.id);
  if (part.type === "image") {
    const localPath = safeString(part.path).trim();
    if (localPath) {
      return h("image", {
        src: localAssetUrl(localPath),
        mimeType: safeString(part.mimeType).trim() || "image/png",
      });
    }
    return h.image(safeString(part.url).trim());
  }
  const localPath = safeString(part.path).trim();
  if (localPath) {
    const buffer = await fs.promises.readFile(path.resolve(localPath));
    return h.file(
      buffer,
      safeString(part.mimeType).trim() || "application/octet-stream",
      {
        name:
          safeString(part.name).trim() ||
          (safeString(part.path).trim()
            ? path.basename(part.path!)
            : undefined),
      },
    );
  }
  return h.file(
    safeString(part.url).trim(),
    safeString(part.mimeType).trim() || undefined,
    {
      name:
        safeString(part.name).trim() ||
        (safeString(part.path).trim() ? path.basename(part.path!) : undefined),
    },
  );
}

export async function sendOutboxPayload(
  app: any,
  agentDir: string,
  payload: ChatOutboxPayload,
  h: any,
) {
  if (payload?.type === "text_delivery") {
    const chatKey = safeString(payload.chatKey).trim();
    const text = safeString(payload.text).trim();
    const replyToMessageId = safeString(payload.replyToMessageId).trim();
    const deliveryResult = await sendText(
      app,
      chatKey,
      text,
      h,
      replyToMessageId,
    );
    if (chatKey && text) {
      appendKoishiChatLog(agentDir, {
        timestamp: new Date().toISOString(),
        chatKey,
        role: "assistant",
        text,
        replyToMessageId: replyToMessageId || undefined,
        sessionId: safeString(payload.sessionId).trim() || undefined,
        sessionFile: safeString(payload.sessionFile).trim() || undefined,
      });
      return recordDeliveredAssistantMessages(agentDir, {
        chatKey,
        deliveryResult,
        text,
        rawContent: text,
        replyToMessageId: replyToMessageId || undefined,
        sessionId: safeString(payload.sessionId).trim() || undefined,
        sessionFile: safeString(payload.sessionFile).trim() || undefined,
      });
    }
    return [] as string[];
  }
  if (payload?.type !== "parts_delivery") return [] as string[];
  const chatKey = safeString(payload.chatKey).trim();
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot)
    throw new Error(
      `no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ""}`,
    );

  const rawParts = Array.isArray(payload.parts)
    ? payload.parts.filter(Boolean)
    : [];
  if (!rawParts.length) throw new Error("chat_outbox_empty_message");

  const nodes = (
    await Promise.all(rawParts.map((part) => messagePartToNode(part, h)))
  ).filter(Boolean);
  if (!nodes.length) throw new Error("chat_outbox_empty_message");

  const deliveryResult = await sendBotMessage(bot, parsed.chatId, nodes);

  const quotePart = rawParts.find((part) => part.type === "quote") as
    | { type: "quote"; id: string }
    | undefined;
  const replyToMessageId = safeString(quotePart?.id).trim() || undefined;

  const finalLoggedText = rawParts
    .filter((part) => part.type === "text")
    .map((part) => safeString((part as any).text).trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (finalLoggedText) {
    appendKoishiChatLog(agentDir, {
      timestamp: new Date().toISOString(),
      chatKey,
      role: "assistant",
      text: finalLoggedText,
      replyToMessageId,
      sessionId: safeString(payload.sessionId).trim() || undefined,
      sessionFile: safeString(payload.sessionFile).trim() || undefined,
    });
  }
  const storedSummary = summarizeOutgoingParts(rawParts);
  return recordDeliveredAssistantMessages(agentDir, {
    chatKey,
    deliveryResult,
    text: finalLoggedText || storedSummary || undefined,
    rawContent: storedSummary || finalLoggedText || undefined,
    replyToMessageId,
    sessionId: safeString(payload.sessionId).trim() || undefined,
    sessionFile: safeString(payload.sessionFile).trim() || undefined,
  });
}

export function buildPromptText(text: string, _attachments: SavedAttachment[]) {
  return text;
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
