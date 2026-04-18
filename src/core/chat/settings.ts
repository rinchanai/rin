function isRecord(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord<T extends Record<string, any>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getStoredChatConfigRoot(settings: any): Record<string, any> {
  if (isRecord(settings?.chat)) return settings.chat;
  if (isRecord(settings?.koishi)) return settings.koishi;
  return {};
}

export function dropLegacyChatSettings(settings: any) {
  const normalized = isRecord(settings) ? settings : {};
  if (isRecord(normalized.koishi)) {
    delete normalized.koishi;
  }
  return normalized;
}

export function normalizeStoredChatSettings(
  settings: any,
  options: { ensureChat?: boolean } = {},
) {
  const normalized = isRecord(settings) ? settings : {};
  const legacyChat = isRecord(normalized.koishi) ? normalized.koishi : undefined;
  const currentChat = isRecord(normalized.chat) ? normalized.chat : undefined;

  if (!currentChat && legacyChat) {
    normalized.chat = cloneRecord(legacyChat);
  }
  dropLegacyChatSettings(normalized);
  if (options.ensureChat && !isRecord(normalized.chat)) {
    normalized.chat = {};
  }
  return normalized;
}
