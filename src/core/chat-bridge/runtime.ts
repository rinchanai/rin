import fs from "node:fs";
import path from "node:path";

import type { ChatMessagePart } from "../rin-lib/chat-outbox.js";
import { readKoishiChatLog } from "../rin-koishi/chat-log.js";
import { normalizeKoishiMessageLookup } from "../rin-koishi/message-store.js";
import {
  findBot,
  loadIdentity,
  parseChatKey,
  setIdentityTrust,
  trustOf,
} from "../rin-koishi/support.js";
import { sendOutboxPayload } from "../rin-koishi/transport.js";
import { serializeBridgeValue } from "./eval.js";

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function inferChatType(parsed: { platform: string; chatId: string }) {
  if (parsed.platform === "telegram") {
    return parsed.chatId.startsWith("-") ? "group" : "private";
  }
  if (parsed.chatId.startsWith("private:")) return "private";
  return "group";
}

function normalizeMessageParts(input: unknown): ChatMessagePart[] {
  if (typeof input === "string") {
    return input ? [{ type: "text", text: input }] : [];
  }
  if (Array.isArray(input)) {
    return input
      .map((item) => normalizeSinglePart(item))
      .filter(Boolean) as ChatMessagePart[];
  }
  const raw = input as any;
  if (Array.isArray(raw?.parts)) return normalizeMessageParts(raw.parts);
  const single = normalizeSinglePart(raw);
  return single ? [single] : [];
}

function normalizeSinglePart(input: any): ChatMessagePart | null {
  const type = safeString(input?.type).trim();
  if (type === "text") {
    return { type: "text", text: safeString(input?.text) };
  }
  if (type === "at") {
    return {
      type: "at",
      id: safeString(input?.id).trim(),
      name: safeString(input?.name).trim() || undefined,
    };
  }
  if (type === "quote") {
    return { type: "quote", id: safeString(input?.id).trim() };
  }
  if (type === "image") {
    return {
      type: "image",
      path: safeString(input?.path).trim() || undefined,
      url: safeString(input?.url).trim() || undefined,
      mimeType: safeString(input?.mimeType).trim() || undefined,
    };
  }
  if (type === "file") {
    return {
      type: "file",
      path: safeString(input?.path).trim() || undefined,
      url: safeString(input?.url).trim() || undefined,
      name: safeString(input?.name).trim() || undefined,
      mimeType: safeString(input?.mimeType).trim() || undefined,
    };
  }
  if (safeString(input?.text)) {
    return { type: "text", text: safeString(input.text) };
  }
  return null;
}

function prependQuote(
  parts: ChatMessagePart[],
  replyToMessageId = "",
): ChatMessagePart[] {
  const nextReplyToMessageId = safeString(replyToMessageId).trim();
  if (!nextReplyToMessageId) return parts;
  if (parts.some((item) => item.type === "quote")) return parts;
  return [{ type: "quote", id: nextReplyToMessageId }, ...parts];
}

function createMethodFacade(target: any, safeFields: string[] = []) {
  const safeFieldSet = new Set(safeFields);
  return new Proxy(
    {},
    {
      get(_obj, prop) {
        if (prop === Symbol.toStringTag) return "ChatBridgeFacade";
        if (typeof prop !== "string") return undefined;
        if (safeFieldSet.has(prop)) return target?.[prop];
        const value = target?.[prop];
        if (typeof value !== "function") return undefined;
        return (...args: unknown[]) => value.apply(target, args);
      },
      has(_obj, prop) {
        if (typeof prop !== "string") return false;
        return safeFieldSet.has(prop) || typeof target?.[prop] === "function";
      },
      ownKeys() {
        return [];
      },
      getOwnPropertyDescriptor() {
        return {
          enumerable: false,
          configurable: true,
        };
      },
    },
  );
}

function createNullHelpers(useChat: (chatKey: string) => any) {
  return {
    currentChatKey: undefined,
    useChat,
    send() {
      throw new Error(
        "chat_bridge_chat_required: use helpers.useChat(chatKey)",
      );
    },
    reply() {
      throw new Error(
        "chat_bridge_chat_required: use helpers.useChat(chatKey)",
      );
    },
    serialize(value: unknown) {
      return serializeBridgeValue(value);
    },
  };
}

function auditDir(agentDir: string) {
  return path.join(path.resolve(agentDir), "data", "chat-bridge-eval");
}

export function appendChatBridgeAudit(
  agentDir: string,
  entry: Record<string, unknown>,
) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const filePath = path.join(auditDir(agentDir), `${day}.jsonl`);
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return filePath;
}

export function createChatBridgeRuntime(options: {
  app: any;
  agentDir: string;
  dataDir: string;
  currentChatKey?: string;
  h: any;
  requestId?: string;
  sessionId?: string;
  sessionFile?: string;
}) {
  const currentChatKey = safeString(options.currentChatKey).trim() || undefined;
  const requestId = safeString(options.requestId).trim() || undefined;
  const sessionId = safeString(options.sessionId).trim() || undefined;
  const sessionFile = safeString(options.sessionFile).trim() || undefined;
  const scopeCache = new Map<string, any>();

  const buildScope = (targetChatKey: string) => {
    const chatKey = safeString(targetChatKey).trim();
    const parsed = parseChatKey(chatKey);
    if (!parsed) throw new Error(`invalid_chatKey:${chatKey || "missing"}`);
    const bot = findBot(options.app, parsed.platform, parsed.botId);
    if (!bot) {
      throw new Error(
        `no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ""}`,
      );
    }
    const currentChat = Object.freeze({
      chatKey,
      platform: parsed.platform,
      botId: parsed.botId,
      chatId: parsed.chatId,
      chatType: inferChatType(parsed),
      requestId,
      sessionId,
      sessionFile,
    });

    const deliver = async (input: unknown, replyToMessageId = "") => {
      const parts = prependQuote(
        normalizeMessageParts(input),
        safeString(replyToMessageId).trim(),
      );
      if (!parts.length) throw new Error("chat_bridge_send_empty");
      return await sendOutboxPayload(
        options.app,
        options.agentDir,
        {
          type: "parts_delivery",
          createdAt: new Date().toISOString(),
          requestId,
          chatKey,
          sessionId,
          sessionFile,
          parts,
        },
        options.h,
      );
    };

    const scope: any = {
      chat: currentChat,
      bot: createMethodFacade(bot, ["platform", "selfId", "status"]),
      internal: createMethodFacade(bot.internal || {}, []),
      h: options.h,
      store: {
        getMessage(messageId: string, nextChatKey?: string) {
          return normalizeKoishiMessageLookup(
            options.agentDir,
            safeString(messageId).trim(),
            safeString(nextChatKey).trim() || chatKey,
          );
        },
        listLog(date?: string, nextChatKey?: string) {
          const nextDate =
            safeString(date).trim() || new Date().toISOString().slice(0, 10);
          return readKoishiChatLog(
            options.agentDir,
            safeString(nextChatKey).trim() || chatKey,
            nextDate,
          );
        },
      },
      identity: {
        getTrust(userId: string, platform?: string) {
          const identity = loadIdentity(options.dataDir);
          return trustOf(
            identity,
            safeString(platform).trim() || parsed.platform,
            safeString(userId).trim(),
          );
        },
        setTrust(input: {
          userId: string;
          trust: "TRUSTED" | "OTHER";
          platform?: string;
          name?: string;
        }) {
          return setIdentityTrust({
            dataDir: options.dataDir,
            platform: safeString(input?.platform).trim() || parsed.platform,
            userId: safeString(input?.userId).trim(),
            trust: safeString(input?.trust).trim() as "TRUSTED" | "OTHER",
            name: safeString(input?.name).trim() || undefined,
          });
        },
      },
    };

    scope.helpers = {
      currentChatKey: chatKey,
      useChat(nextChatKey: string) {
        return getScope(nextChatKey);
      },
      send(input: unknown) {
        return deliver(input);
      },
      reply(replyToMessageId: string, input: unknown) {
        return deliver(input, replyToMessageId);
      },
      serialize(value: unknown) {
        return serializeBridgeValue(value);
      },
    };
    return scope;
  };

  const getScope = (chatKey: string) => {
    const nextChatKey = safeString(chatKey).trim();
    if (!nextChatKey) throw new Error("chat_bridge_chat_required");
    let scope = scopeCache.get(nextChatKey);
    if (!scope) {
      scope = buildScope(nextChatKey);
      scopeCache.set(nextChatKey, scope);
    }
    return scope;
  };

  const currentScope = currentChatKey ? getScope(currentChatKey) : null;
  return {
    chat: currentScope?.chat || null,
    bot: currentScope?.bot,
    internal: currentScope?.internal,
    h: options.h,
    store: currentScope?.store,
    identity: currentScope?.identity,
    helpers: currentScope?.helpers || createNullHelpers(getScope),
  };
}
