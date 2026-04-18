import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { extname } from "node:path";

import YAML from "yaml";

import { listChatBridgeAdapterSpecs } from "../chat-bridge/adapters.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../platform/fs.js";
import { safeString } from "../text-utils.js";
import { getStoredChatConfigRoot } from "./settings.js";

export { ensureDir, readJsonFile, writeJsonFile };

function normalizeChatAdapterConfig(
  value: any,
  defaults: Record<string, any> = {},
) {
  const current =
    value && typeof value === "object" && !Array.isArray(value)
      ? JSON.parse(JSON.stringify(value))
      : {};
  return { ...defaults, ...current };
}

function sanitizeAdapterName(value: any, fallback: string) {
  const raw = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  return raw || fallback;
}

function looksLikeSingleAdapterConfig(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return true;
  const singleConfigKeys = new Set([
    "name",
    "enabled",
    "endpoint",
    "selfId",
    "token",
    "protocol",
    "slash",
    "owners",
    "ownerUserIds",
    "botId",
  ]);
  if (keys.some((key) => singleConfigKeys.has(key))) return true;
  return keys.some((key) => {
    const entry = value[key];
    return !entry || typeof entry !== "object" || Array.isArray(entry);
  });
}

function normalizeAdapterEntries(
  value: any,
  defaults: Record<string, any>,
  fallbackPrefix: string,
) {
  const rawEntries: Array<{ name: string; config: Record<string, any> }> = [];

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      rawEntries.push({
        name: sanitizeAdapterName(
          (entry as any).name,
          `${fallbackPrefix}-${index + 1}`,
        ),
        config: JSON.parse(JSON.stringify(entry)),
      });
    });
  } else if (looksLikeSingleAdapterConfig(value)) {
    rawEntries.push({
      name: sanitizeAdapterName(value && value.name, fallbackPrefix),
      config:
        value && typeof value === "object"
          ? JSON.parse(JSON.stringify(value))
          : {},
    });
  } else if (value && typeof value === "object") {
    for (const [name, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      rawEntries.push({
        name: sanitizeAdapterName(
          (entry as any).name || name,
          safeString(name) || fallbackPrefix,
        ),
        config: JSON.parse(JSON.stringify(entry)),
      });
    }
  }

  return rawEntries
    .filter((entry) => entry.config.enabled !== false)
    .map((entry) => {
      const config = normalizeChatAdapterConfig(entry.config, defaults);
      delete (config as any).name;
      delete (config as any).owners;
      delete (config as any).ownerUserIds;
      delete (config as any).botId;
      return { name: entry.name, config };
    });
}

function applyAdapterPlugins(
  plugins: Record<string, any>,
  baseName: string,
  value: any,
  defaults: Record<string, any>,
  fallbackPrefix: string,
) {
  const entries = normalizeAdapterEntries(value, defaults, fallbackPrefix);
  if (!entries.length) return;
  entries.forEach((entry, index) => {
    const key =
      index === 0 ? baseName : `${baseName}:${entry.name || index + 1}`;
    plugins[key] = entry.config;
  });
}

function normalizeCustomChatAdapters(settings: any) {
  const chat = getStoredChatConfigRoot(settings);
  const items = Array.isArray(chat?.customAdapters) ? chat.customAdapters : [];
  return items
    .map((item) => {
      const adapter =
        item && typeof item === "object" && !Array.isArray(item) ? item : null;
      const packageName = safeString(adapter?.packageName).trim();
      const version = safeString(adapter?.version).trim() || "latest";
      const pluginKey = safeString(adapter?.pluginKey).trim();
      const config = adapter?.config;
      const defaults =
        adapter?.defaults &&
        typeof adapter.defaults === "object" &&
        !Array.isArray(adapter.defaults)
          ? JSON.parse(JSON.stringify(adapter.defaults))
          : {};
      const fallbackPrefix =
        safeString(adapter?.name).trim() ||
        pluginKey.replace(/^adapter-/, "") ||
        packageName.replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
      const enabled = adapter?.enabled !== false;
      return {
        packageName,
        version,
        pluginKey,
        config,
        defaults,
        fallbackPrefix,
        enabled,
      };
    })
    .filter(
      (item) =>
        item.enabled && item.packageName && item.pluginKey && item.config,
    );
}

export function buildChatConfigFromSettings(settings: any) {
  const config = {
    name: "rin",
    prefix: ["/"],
    prefixMode: "strict",
    plugins: {
      "proxy-agent": {},
      http: {},
    } as Record<string, any>,
  };

  const chat = getStoredChatConfigRoot(settings);

  for (const adapter of listChatBridgeAdapterSpecs()) {
    applyAdapterPlugins(
      config.plugins,
      adapter.pluginKey,
      chat?.[adapter.key],
      adapter.defaults,
      adapter.key,
    );
  }

  for (const adapter of normalizeCustomChatAdapters(settings)) {
    applyAdapterPlugins(
      config.plugins,
      adapter.pluginKey,
      adapter.config,
      adapter.defaults,
      adapter.fallbackPrefix,
    );
  }

  return config;
}

export type ChatRuntimeAdapterEntry = {
  key: string;
  name: string;
  config: Record<string, any>;
  builtIn: boolean;
  packageName?: string;
};

export function listChatRuntimeAdapterEntries(settings: any) {
  const chat = getStoredChatConfigRoot(settings);
  const entries: ChatRuntimeAdapterEntry[] = [];

  for (const adapter of listChatBridgeAdapterSpecs()) {
    for (const entry of normalizeAdapterEntries(
      chat?.[adapter.key],
      adapter.defaults,
      adapter.key,
    )) {
      entries.push({
        key: adapter.key,
        name: entry.name,
        config: entry.config,
        builtIn: true,
      });
    }
  }

  for (const adapter of normalizeCustomChatAdapters(settings)) {
    for (const entry of normalizeAdapterEntries(
      adapter.config,
      adapter.defaults,
      adapter.fallbackPrefix,
    )) {
      entries.push({
        key: adapter.fallbackPrefix,
        name: entry.name,
        config: entry.config,
        builtIn: false,
        packageName: adapter.packageName,
      });
    }
  }

  return entries;
}

export function buildChatRuntimePackageJson(settings: any) {
  const dependencies: Record<string, string> = {};

  for (const adapter of normalizeCustomChatAdapters(settings)) {
    dependencies[adapter.packageName] = adapter.version;
  }

  const sortedDependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    name: "rin-chat-runtime",
    private: true,
    version: "0.0.0",
    dependencies: sortedDependencies,
  };
}

function dependencyInstallPath(rootDir: string, packageName: string) {
  const normalized = safeString(packageName).trim();
  if (!normalized) return "";
  return path.join(rootDir, "node_modules", ...normalized.split("/"));
}

export function shouldInstallChatRuntimeDependencies(
  rootDir: string,
  settings: any,
) {
  const runtimePackage = buildChatRuntimePackageJson(settings);
  const dependencies = runtimePackage.dependencies || {};
  if (!Object.keys(dependencies).length) return false;
  const packageJsonPath = path.join(rootDir, "package.json");
  const lockPath = path.join(rootDir, "package-lock.json");
  const expectedText = `${JSON.stringify(runtimePackage, null, 2)}\n`;
  const currentText = fs.existsSync(packageJsonPath)
    ? fs.readFileSync(packageJsonPath, "utf8")
    : "";
  if (currentText !== expectedText) return true;
  if (!fs.existsSync(lockPath)) return true;
  return Object.keys(dependencies).some(
    (packageName) =>
      !fs.existsSync(dependencyInstallPath(rootDir, packageName)),
  );
}

export function ensureChatRuntimeDependencies(rootDir: string, settings: any) {
  const runtimePackage = buildChatRuntimePackageJson(settings);
  const dependencies = runtimePackage.dependencies || {};
  if (!shouldInstallChatRuntimeDependencies(rootDir, settings)) {
    return {
      installed: false,
      dependencies,
      rootDir,
    };
  }
  if (!Object.keys(dependencies).length) {
    return {
      installed: false,
      dependencies,
      rootDir,
    };
  }
  ensureDir(rootDir);
  const packageJsonPath = path.join(rootDir, "package.json");
  writeJsonFile(packageJsonPath, runtimePackage);
  try {
    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--legacy-peer-deps",
      ],
      {
        cwd: rootDir,
        stdio: "pipe",
        encoding: "utf8",
      },
    );
  } catch (error: any) {
    const detail = safeString(
      error?.stderr || error?.stdout || error?.message || error,
    ).trim();
    throw new Error(`chat_runtime_install_failed${detail ? `:${detail}` : ""}`);
  }
  return {
    installed: true,
    dependencies,
    rootDir,
  };
}

export function materializeChatConfig(configPath: string, settings: any) {
  const rootDir = path.dirname(configPath);
  ensureDir(rootDir);
  const config = buildChatConfigFromSettings(settings);
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
  const packageJsonPath = path.join(rootDir, "package.json");
  writeJsonFile(packageJsonPath, buildChatRuntimePackageJson(settings));
  return { configPath, config };
}

function platformRequiresBotId(platform: string) {
  const nextPlatform = safeString(platform).trim().toLowerCase();
  return nextPlatform === "telegram" || nextPlatform === "onebot";
}

export function composeChatKey(platform: string, chatId: string, botId = "") {
  const nextPlatform = safeString(platform).trim();
  const nextChatId = safeString(chatId).trim();
  const nextBotId = safeString(botId).trim();
  if (!nextPlatform || !nextChatId) return "";
  if (platformRequiresBotId(nextPlatform) && !nextBotId) return "";
  return `${nextPlatform}/${nextBotId}:${nextChatId}`;
}

export function parseChatKey(chatKey: string) {
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

export function ensureFileName(name: string, fallback = "attachment") {
  const base = safeString(name)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^\.+$/, "");
  return base || fallback;
}

export function fileNameFromUrl(url: string, fallback = "attachment") {
  try {
    const pathname = new URL(url).pathname;
    const name = decodeURIComponent(path.basename(pathname));
    return ensureFileName(name, fallback);
  } catch {
    return ensureFileName(path.basename(url), fallback);
  }
}

export function extensionFromMimeType(mimeType: string) {
  const mime = safeString(mimeType).toLowerCase().trim();
  if (!mime) return "";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "application/pdf") return ".pdf";
  if (mime === "text/plain") return ".txt";
  return "";
}

export function ensureExtension(fileName: string, mimeType = "") {
  const ext = extname(fileName);
  if (ext) return fileName;
  const inferred = extensionFromMimeType(mimeType);
  return inferred ? `${fileName}${inferred}` : fileName;
}
