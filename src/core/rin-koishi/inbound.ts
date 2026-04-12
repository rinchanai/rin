import { appendKoishiChatLog } from "./chat-log.js";
import {
  elementsToText,
  ensureSessionElements,
  getChatId,
  persistInboundMessage,
  pickMessageId,
  pickReplyToMessageId,
  pickSenderNickname,
  pickUserId,
  safeString,
} from "./chat-helpers.js";
import { composeChatKey, loadIdentity, trustOf } from "./support.js";

export async function buildTelegramInboundMediaDebug(session: any) {
  const update = session?.telegram;
  if (!update || typeof update !== "object") return undefined;
  const message =
    update?.message ||
    update?.edited_message ||
    update?.channel_post ||
    update?.edited_channel_post;
  if (!message || typeof message !== "object") return undefined;
  const photo = Array.isArray(message?.photo) ? message.photo : [];
  const candidates = [
    ...photo.map((item: any) => ({
      kind: "photo",
      fileId: safeString(item?.file_id || "").trim(),
      fileUniqueId: safeString(item?.file_unique_id || "").trim() || undefined,
      fileSize: Number.isFinite(Number(item?.file_size))
        ? Number(item.file_size)
        : undefined,
      width: Number.isFinite(Number(item?.width))
        ? Number(item.width)
        : undefined,
      height: Number.isFinite(Number(item?.height))
        ? Number(item.height)
        : undefined,
    })),
    message?.document
      ? {
          kind: "document",
          fileId: safeString(message.document?.file_id || "").trim(),
          fileUniqueId:
            safeString(message.document?.file_unique_id || "").trim() ||
            undefined,
          fileSize: Number.isFinite(Number(message.document?.file_size))
            ? Number(message.document.file_size)
            : undefined,
          mimeType:
            safeString(message.document?.mime_type || "").trim() || undefined,
          fileName:
            safeString(message.document?.file_name || "").trim() || undefined,
        }
      : null,
  ]
    .filter(Boolean)
    .filter((item: any) => item.fileId);
  if (!candidates.length) return undefined;
  const lookups: any[] = [];
  const getFile = session?.bot?.internal?.getFile;
  if (typeof getFile === "function") {
    for (const item of candidates.slice(0, 4)) {
      try {
        const file = await getFile.call(session.bot.internal, {
          file_id: item.fileId,
        });
        lookups.push({
          fileId: item.fileId,
          ok: true,
          filePath: safeString(file?.file_path || "").trim() || undefined,
          fileSize: Number.isFinite(Number(file?.file_size))
            ? Number(file.file_size)
            : undefined,
        });
      } catch (error: any) {
        lookups.push({
          fileId: item.fileId,
          ok: false,
          error: safeString(
            error?.description || error?.message || error,
          ).trim(),
        });
      }
    }
  }
  return {
    messageId: safeString(message?.message_id || "").trim() || undefined,
    photoCount: photo.length || undefined,
    media: candidates,
    lookups: lookups.length ? lookups : undefined,
  };
}

export function recordKoishiInboundMessage(input: {
  runtimeAgentDir: string;
  session: any;
}) {
  const { runtimeAgentDir, session } = input;
  const elements = ensureSessionElements(session);
  persistInboundMessage(
    runtimeAgentDir,
    session,
    elements,
    loadIdentity(runtimeAgentDir),
    trustOf,
  );
  const platform = safeString(session?.platform || "").trim();
  const botId = safeString(
    session?.selfId || session?.bot?.selfId || "",
  ).trim();
  const chatKey = composeChatKey(platform, getChatId(session), botId);
  const text = elementsToText(elements);
  if (!chatKey || !text) return;
  appendKoishiChatLog(runtimeAgentDir, {
    timestamp: new Date().toISOString(),
    chatKey,
    role: "user",
    text,
    messageId: pickMessageId(session) || undefined,
    replyToMessageId: pickReplyToMessageId(session) || undefined,
    userId: pickUserId(session) || undefined,
    nickname: pickSenderNickname(session) || undefined,
  });
}
