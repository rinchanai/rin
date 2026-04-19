import { cloneJson, isJsonRecord } from "../json-utils.js";

export function getStoredChatConfigRoot(settings: any): Record<string, any> {
  if (isJsonRecord(settings?.chat)) return settings.chat;
  if (isJsonRecord(settings?.koishi)) return settings.koishi;
  return {};
}

export function dropLegacyChatSettings(settings: any) {
  const normalized = isJsonRecord(settings) ? settings : {};
  if (isJsonRecord(normalized.koishi)) {
    delete normalized.koishi;
  }
  return normalized;
}

export function normalizeStoredChatSettings(
  settings: any,
  options: { ensureChat?: boolean } = {},
) {
  const normalized = isJsonRecord(settings) ? settings : {};
  const legacyChat = isJsonRecord(normalized.koishi)
    ? normalized.koishi
    : undefined;
  const currentChat = isJsonRecord(normalized.chat)
    ? normalized.chat
    : undefined;

  if (!currentChat && legacyChat) {
    normalized.chat = cloneJson(legacyChat);
  }
  dropLegacyChatSettings(normalized);
  if (options.ensureChat && !isJsonRecord(normalized.chat)) {
    normalized.chat = {};
  }
  return normalized;
}
