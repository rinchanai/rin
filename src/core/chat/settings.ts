import { isJsonRecord } from "../json-utils.js";

export function getStoredChatConfigRoot(settings: any): Record<string, any> {
  return isJsonRecord(settings?.chat) ? settings.chat : {};
}

export function dropLegacyChatSettings(settings: any) {
  const normalized = isJsonRecord(settings) ? settings : {};
  if (normalized.koishi !== undefined) delete normalized.koishi;
  return normalized;
}

export function normalizeStoredChatSettings(
  settings: any,
  options: { ensureChat?: boolean } = {},
) {
  const normalized = dropLegacyChatSettings(
    isJsonRecord(settings) ? settings : {},
  );
  if (options.ensureChat && !isJsonRecord(normalized.chat)) {
    normalized.chat = {};
  }
  return normalized;
}
