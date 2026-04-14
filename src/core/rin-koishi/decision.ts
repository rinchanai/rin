import { canAccessAgentInput } from "../chat-bridge/policy.js";

import { composeChatKey, trustOf } from "./support.js";
import {
  directLike,
  elementsToText,
  getChatId,
  hasMediaElements,
  mentionLike,
  pickUserId,
  safeString,
} from "./chat-helpers.js";

export async function isPrivateLikeGroupSession(session: any, trust: string) {
  if (!session?.guildId || trust !== "OWNER") return false;
  const platform = safeString(session?.platform || "").trim();
  const chatId = getChatId(session);
  if (!platform || !chatId) return false;
  const bot = session?.bot;

  try {
    if (
      platform === "telegram" &&
      bot?.internal &&
      typeof bot.internal.getChatMemberCount === "function"
    ) {
      const count = Number(
        await bot.internal.getChatMemberCount({ chat_id: chatId }),
      );
      return Number.isFinite(count) && count > 0 && count <= 2;
    }
    if (
      platform === "onebot" &&
      bot?.internal &&
      typeof bot.internal.getGroupInfo === "function"
    ) {
      const info = await bot.internal.getGroupInfo(chatId, true);
      const count = Number(info?.member_count ?? info?.memberCount ?? 0);
      return Number.isFinite(count) && count > 0 && count <= 2;
    }
  } catch {}

  return false;
}

export async function shouldProcessText(
  session: any,
  elements: any[],
  identity: any,
) {
  const text = elementsToText(elements);
  const hasMedia = hasMediaElements(elements);
  if (!text && !hasMedia)
    return {
      allow: false,
      text: "",
      chatKey: "",
      trust: "OTHER",
    };
  const platform = safeString(session?.platform || "").trim();
  const botId = safeString(
    session?.selfId || session?.bot?.selfId || "",
  ).trim();
  const chatId = getChatId(session);
  const chatKey = composeChatKey(platform, chatId, botId);
  const trust = trustOf(identity, platform, pickUserId(session));
  const privateLike =
    directLike(session) || (await isPrivateLikeGroupSession(session, trust));
  const allow = canAccessAgentInput({
    chatType: privateLike ? "private" : "group",
    trust,
    mentionLike: mentionLike(session),
    commandLike: false,
  });

  return { allow, text, chatKey, trust };
}
