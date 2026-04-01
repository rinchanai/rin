import { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";
import { canAccessAgentInput, canRunCommand } from "../chat-bridge/policy.js";

import { composeChatKey, trustOf } from "./support.js";
import {
  commandNameFromText,
  directLike,
  getChatId,
  getIncomingText,
  isCommandText,
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
  identity: any,
  registeredCommands: Set<string>,
) {
  const text = getIncomingText(session);
  if (!text)
    return {
      allow: false,
      text: "",
      chatKey: "",
      trust: "OTHER",
      commandName: "",
    };
  const platform = safeString(session?.platform || "").trim();
  const botId = safeString(
    session?.selfId || session?.bot?.selfId || "",
  ).trim();
  const chatId = getChatId(session);
  const chatKey = composeChatKey(platform, chatId, botId);
  const trust = trustOf(identity, platform, pickUserId(session));
  const commandName = commandNameFromText(text);
  const commandLike = isCommandText(text);
  const privateLike =
    directLike(session) || (await isPrivateLikeGroupSession(session, trust));
  const allow = commandLike
    ? commandName
      ? canRunCommand(trust, commandName)
      : false
    : canAccessAgentInput({
        chatType: privateLike ? "private" : "group",
        trust,
        mentionLike: mentionLike(session),
        commandLike: false,
      });

  if (
    commandLike &&
    (registeredCommands.has(commandName) || commandName === "help")
  ) {
    return {
      allow: false,
      text,
      chatKey,
      trust,
      commandName,
      registered: true,
    };
  }

  return { allow, text, chatKey, trust, commandName, registered: false };
}

export async function discoverRpcCommands() {
  const client = new RinDaemonFrontendClient();
  await client.connect();
  try {
    const commands = await client.getCommands();
    return commands
      .map((item) => ({
        name: safeString(item.name).replace(/^\//, ""),
        description: safeString(item.description || "").trim(),
      }))
      .filter((item) => item.name);
  } finally {
    await client.disconnect().catch(() => {});
  }
}
