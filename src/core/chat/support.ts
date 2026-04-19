import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { ensureDir, readJsonFile, writeJsonFile } from "../platform/fs.js";
import { safeString } from "../text-utils.js";

export { ensureDir, readJsonFile, writeJsonFile } from "../platform/fs.js";
export {
  ensureExtension,
  ensureFileName,
  extensionFromMimeType,
  fileNameFromUrl,
} from "./file-utils.js";
export {
  buildChatConfigFromSettings,
  buildChatRuntimePackageJson,
  ensureChatRuntimeDependencies,
  listChatRuntimeAdapterEntries,
  materializeChatConfig,
  shouldInstallChatRuntimeDependencies,
} from "./runtime-config.js";
export type { ChatRuntimeAdapterEntry } from "./runtime-config.js";

export type ParsedChatKey = {
  platform: string;
  botId: string;
  chatId: string;
};

export type ChatType = "private" | "group";

function platformRequiresBotId(platform: string) {
  const nextPlatform = safeString(platform).trim().toLowerCase();
  return nextPlatform === "telegram" || nextPlatform === "onebot";
}

export function inferChatType(target: {
  platform: string;
  chatId: string;
}): ChatType {
  const platform = safeString(target?.platform).trim();
  const chatId = safeString(target?.chatId).trim();
  if (platform === "telegram") {
    return chatId.startsWith("-") ? "group" : "private";
  }
  return chatId.startsWith("private:") ? "private" : "group";
}

export function isPrivateChat(target: { platform: string; chatId: string }) {
  return inferChatType(target) === "private";
}

export function composeChatKey(platform: string, chatId: string, botId = "") {
  const nextPlatform = safeString(platform).trim();
  const nextChatId = safeString(chatId).trim();
  const nextBotId = safeString(botId).trim();
  if (!nextPlatform || !nextChatId) return "";
  if (platformRequiresBotId(nextPlatform) && !nextBotId) return "";
  return `${nextPlatform}/${nextBotId}:${nextChatId}`;
}

export function parseChatKey(chatKey: string): ParsedChatKey | null {
  const match = safeString(chatKey)
    .trim()
    .match(/^([^/:]+)(?:\/([^:]+))?:(.+)$/);
  if (!match) return null;
  const [, platform, botId = "", chatId] = match;
  if (!platform || !chatId) return null;
  if (platformRequiresBotId(platform) && !safeString(botId).trim()) return null;
  return { platform, botId, chatId };
}

export function normalizeChatKey(value: unknown) {
  const chatKey = safeString(value).trim();
  return parseChatKey(chatKey) ? chatKey : undefined;
}

export function chatStateDir(dataDir: string, chatKey: string) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  return parsed.botId
    ? path.join(dataDir, "chats", parsed.platform, parsed.botId, parsed.chatId)
    : path.join(dataDir, "chats", parsed.platform, parsed.chatId);
}

export function chatStatePath(dataDir: string, chatKey: string) {
  return path.join(chatStateDir(dataDir, chatKey), "state.json");
}

export function listChatStateFiles(chatsRoot: string) {
  const out: Array<{ chatKey: string; statePath: string }> = [];
  try {
    const platforms = fs
      .readdirSync(chatsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const platform of platforms) {
      const platformDir = path.join(chatsRoot, platform);
      const levelOne = fs
        .readdirSync(platformDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const first of levelOne) {
        const firstDir = path.join(platformDir, first);
        const directStatePath = path.join(firstDir, "state.json");
        if (fs.existsSync(directStatePath)) {
          if (!platformRequiresBotId(platform)) {
            out.push({
              chatKey: composeChatKey(platform, first),
              statePath: directStatePath,
            });
          }
          continue;
        }
        const levelTwo = fs
          .readdirSync(firstDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
        for (const chatId of levelTwo) {
          const statePath = path.join(firstDir, chatId, "state.json");
          if (fs.existsSync(statePath))
            out.push({
              chatKey: composeChatKey(platform, chatId, first),
              statePath,
            });
        }
      }
    }
  } catch {}
  return out;
}

export function listDetachedControllerStateFiles(cronTurnsRoot: string) {
  const out: Array<{
    controllerKey: string;
    statePath: string;
    chatKey: string;
  }> = [];
  try {
    const entries = fs
      .readdirSync(cronTurnsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const controllerKey of entries) {
      const statePath = path.join(cronTurnsRoot, controllerKey, "state.json");
      if (!fs.existsSync(statePath)) continue;
      const state = readJsonFile<any>(statePath, {}) || {};
      out.push({
        controllerKey,
        statePath,
        chatKey: safeString(state.chatKey).trim() || `cron:${controllerKey}`,
      });
    }
  } catch {}
  return out;
}

export function identityPath(dataDir: string) {
  return path.join(dataDir, "identity.json");
}

export function ensureIdentitySeed(dataDir: string) {
  const filePath = identityPath(dataDir);
  if (fs.existsSync(filePath)) return;
  writeJsonFile(filePath, {
    persons: { owner: { trust: "OWNER" } },
    aliases: [],
    trusted: [],
  });
}

export function loadIdentity(dataDir: string) {
  ensureIdentitySeed(dataDir);
  const identity = readJsonFile<any>(identityPath(dataDir), {
    persons: {},
    aliases: [],
    trusted: [],
  });
  identity.persons ||= {};
  identity.aliases ||= [];
  identity.trusted ||= [];
  return identity;
}

export function saveIdentity(dataDir: string, identity: any) {
  writeJsonFile(identityPath(dataDir), identity);
}

function trustPersonId(platform: string, userId: string, trust: string) {
  const key = `${safeString(platform).trim()}\n${safeString(userId).trim()}\n${safeString(trust).trim()}`;
  const prefix =
    safeString(trust).trim().toLowerCase() === "trusted" ? "trusted" : "other";
  return `${prefix}_${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
}

export function setIdentityTrust(options: {
  dataDir: string;
  platform: string;
  userId: string;
  trust: "TRUSTED" | "OTHER";
  name?: string;
}) {
  const platform = safeString(options.platform).trim();
  const userId = safeString(options.userId).trim();
  const trust = safeString(options.trust).trim() as "TRUSTED" | "OTHER";
  const name = safeString(options.name).trim();
  if (!platform) throw new Error("identity_platform_required");
  if (!userId) throw new Error("identity_user_id_required");
  if (trust !== "TRUSTED" && trust !== "OTHER") {
    throw new Error("identity_trust_invalid");
  }

  const identity = loadIdentity(options.dataDir);
  const aliases = Array.isArray(identity.aliases) ? identity.aliases : [];
  const persons =
    identity.persons && typeof identity.persons === "object"
      ? identity.persons
      : {};
  const aliasIndex = aliases.findIndex(
    (entry: any) =>
      entry && entry.platform === platform && String(entry.userId) === userId,
  );
  const existingAlias = aliasIndex >= 0 ? aliases[aliasIndex] : undefined;
  const existingPersonId = safeString(existingAlias?.personId).trim();
  if (existingPersonId === "owner") {
    throw new Error("identity_owner_trust_immutable");
  }

  const personId = existingPersonId || trustPersonId(platform, userId, trust);
  const existingPerson =
    persons[personId] && typeof persons[personId] === "object"
      ? persons[personId]
      : {};
  persons[personId] = {
    ...existingPerson,
    ...(name ? { name } : {}),
    trust,
  };
  if (aliasIndex >= 0) {
    aliases[aliasIndex] = {
      ...aliases[aliasIndex],
      platform,
      userId,
      personId,
    };
  } else {
    aliases.push({ platform, userId, personId });
  }

  identity.persons = persons;
  identity.aliases = aliases;
  identity.trusted = Object.entries(persons)
    .filter(([, person]: any) => safeString(person?.trust).trim() === "TRUSTED")
    .map(([id]) => id);
  saveIdentity(options.dataDir, identity);
  return {
    platform,
    userId,
    trust,
    name: safeString(identity.persons?.[personId]?.name).trim() || undefined,
    personId,
    path: identityPath(options.dataDir),
  };
}

export function trustOf(identity: any, platform: string, userId: string) {
  const nextPlatform = safeString(platform).trim();
  const nextUserId = safeString(userId).trim();
  if (!nextPlatform || !nextUserId) return "OTHER";
  const alias = (Array.isArray(identity?.aliases) ? identity.aliases : []).find(
    (entry: any) =>
      entry &&
      entry.platform === nextPlatform &&
      String(entry.userId) === nextUserId,
  );
  const personId = safeString(alias?.personId).trim();
  if (!personId) return "OTHER";
  return safeString(identity?.persons?.[personId]?.trust || "OTHER") || "OTHER";
}

export function canAccessAgentInput({
  chatType,
  trust,
  mentionLike = false,
  commandLike = false,
}: {
  chatType: "private" | "group";
  trust: string;
  mentionLike?: boolean;
  commandLike?: boolean;
}) {
  if (commandLike) return false;
  if (chatType === "private") return trust === "OWNER";
  return Boolean(mentionLike) && (trust === "OWNER" || trust === "TRUSTED");
}

const TRUSTED_COMMANDS = new Set(["new", "abort", "status"]);

export function canRunCommand(trust: string, commandName: string) {
  const nextTrust = safeString(trust).trim();
  const nextName = safeString(commandName).trim().replace(/^\//, "");
  if (!nextName) return false;
  if (nextTrust === "OWNER") return true;
  if (nextTrust === "TRUSTED") return TRUSTED_COMMANDS.has(nextName);
  return false;
}

export function findBot(app: any, platform: string, botId = "") {
  const bots = Array.isArray(app?.bots) ? app.bots : [];
  const nextPlatform = safeString(platform).trim();
  const nextBotId = safeString(botId).trim();
  if (!nextPlatform) return null;
  const matches = bots.filter(
    (bot: any) => bot && bot.platform === nextPlatform,
  );
  if (!matches.length) return null;
  if (!nextBotId)
    return platformRequiresBotId(nextPlatform) ? null : matches[0];
  return (
    matches.find((bot: any) => safeString(bot?.selfId).trim() === nextBotId) ||
    null
  );
}
