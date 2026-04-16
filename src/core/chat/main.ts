#!/usr/bin/env node
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import {
  executeChatBridgeCode,
  renderChatBridgeResult,
} from "../chat-bridge/eval.js";
import {
  appendChatBridgeAudit,
  createChatBridgeRuntime,
} from "../chat-bridge/runtime.js";
import { canRunCommand } from "../chat-bridge/policy.js";
import { enqueueChatPromptContext } from "../chat-bridge/prompt-context.js";
import {
  chatStateDir,
  listChatStateFiles,
  listDetachedControllerStateFiles,
} from "../chat-bridge/session-binding.js";
import { getChatCommandRows, syncTelegramCommands } from "./boot.js";
import {
  elementsToText,
  ensureDir,
  ensureSessionElements,
  extractInboundAttachments,
  buildInboundAttachmentNotice,
  getChatId,
  getChatType,
  lookupReplySession,
  persistInboundMessage,
  pickChatName,
  pickMessageId,
  pickReplyToMessageId,
  pickSenderNickname,
  pickUserId,
  safeString,
} from "./chat-helpers.js";
import { ChatController, loadChatSettings } from "./controller.js";
import { appendChatLog } from "./chat-log.js";
import {
  claimChatInboxFile,
  completeChatInboxFile,
  enqueueChatInboxItem,
  listPendingChatInboxFiles,
  readChatInboxItem,
  requeueChatInboxFile,
  restoreChatInboxFile,
} from "./inbox.js";
import { shouldProcessText } from "./decision.js";
import {
  createChatRuntimeApp,
  createChatRuntimeH,
  instantiateBuiltInChatRuntimeAdapters,
} from "../chat-runtime/index.js";
import {
  composeChatKey,
  listChatRuntimeAdapterEntries,
  loadIdentity,
  trustOf,
} from "./support.js";
import { chatRpcSocketPath } from "./rpc.js";
import { getChatMessage } from "./message-store.js";
import { sendOutboxPayload } from "./transport.js";

function createLogger(name: string) {
  const prefix = `[${name}]`;
  return {
    debug: (...args: any[]) => console.debug(prefix, ...args),
    info: (...args: any[]) => console.info(prefix, ...args),
    warn: (...args: any[]) => console.warn(prefix, ...args),
    error: (...args: any[]) => console.error(prefix, ...args),
  };
}

const logger = createLogger("rin-chat");
const RIN_CHAT_SETTINGS_PATH_ENV = "RIN_CHAT_SETTINGS_PATH";
const LEGACY_RIN_KOISHI_SETTINGS_PATH_ENV = "RIN_KOISHI_SETTINGS_PATH";
const TYPING_POLL_INTERVAL_MS = 4000;
const CHAT_INBOX_POLL_INTERVAL_MS = 3000;
const CHAT_INBOX_ACCEPT_TIMEOUT_MS = 5000;
const CHAT_INBOX_RETRY_MIN_MS = 2000;
const CHAT_INBOX_RETRY_MAX_MS = 60_000;
const TRANSIENT_CHAT_RUNTIME_ERROR_RE =
  /rin_timeout:|rin_disconnected:|rin_tui_not_connected|chat_controller_disposed|rin_worker_exit:|chat_turn_stale/;

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientChatRuntimeError(error: unknown) {
  return TRANSIENT_CHAT_RUNTIME_ERROR_RE.test(safeString((error as any)?.message || error));
}

function computeChatInboxRetryDelay(attemptCount: number) {
  const attempt = Math.max(0, Number(attemptCount || 0));
  return Math.min(CHAT_INBOX_RETRY_MAX_MS, CHAT_INBOX_RETRY_MIN_MS * 2 ** attempt);
}

async function buildTelegramInboundMediaDebug(session: any) {
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

function getCommandTargets(session: any) {
  return new Set(
    [
      session?.bot?.user?.name,
      session?.bot?.user?.username,
      session?.bot?.username,
      session?.bot?.name,
      session?.username,
      session?.selfId,
    ]
      .map((value) => safeString(value).trim().replace(/^@+/, "").toLowerCase())
      .filter(Boolean),
  );
}

function parseInboundCommand(
  session: any,
  text: string,
  commandRows: Array<{ name: string }>,
) {
  const input = safeString(text).trim();
  if (!input.startsWith("/")) return null;
  const spaceIndex = input.indexOf(" ");
  const head = (spaceIndex >= 0 ? input.slice(0, spaceIndex) : input)
    .slice(1)
    .trim();
  if (!head) return null;
  const argsText = spaceIndex >= 0 ? input.slice(spaceIndex + 1).trim() : "";
  const [rawName, rawTarget = ""] = head.split("@", 2);
  const name = safeString(rawName).trim().toLowerCase();
  if (!name) return null;
  if (!commandRows.some((item) => safeString(item?.name).trim() === name)) {
    return null;
  }
  const target = safeString(rawTarget).trim().replace(/^@+/, "").toLowerCase();
  if (target) {
    const targets = getCommandTargets(session);
    if (targets.size && !targets.has(target)) return null;
  }
  return { name, argsText };
}

export async function startChatBridge(
  options: { additionalExtensionPaths?: string[] } = {},
) {
  const runtime = resolveRuntimeProfile();
  const dataDir = path.join(runtime.agentDir, "data");
  const settingsPath =
    process.env[RIN_CHAT_SETTINGS_PATH_ENV]?.trim() ||
    process.env[LEGACY_RIN_KOISHI_SETTINGS_PATH_ENV]?.trim() ||
    path.join(runtime.agentDir, "settings.json");
  applyRuntimeProfileEnvironment(runtime);
  if (process.cwd() !== runtime.cwd) process.chdir(runtime.cwd);
  ensureDir(dataDir);

  const settings = loadChatSettings(settingsPath);

  const h = createChatRuntimeH();
  const app = createChatRuntimeApp();
  const runtimeAdapters = instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir,
    settings,
    adapterEntries: listChatRuntimeAdapterEntries(settings),
    logger,
  });
  if (!runtimeAdapters.length) {
    logger.warn("no runtime chat adapters configured");
  }
  const controllers = new Map<string, ChatController>();
  const detachedControllers = new Map<string, ChatController>();
  let inboxPollTimer: NodeJS.Timeout | null = null;
  const typingPollTimer = setInterval(() => {
    for (const controller of controllers.values()) {
      void controller.housekeep().catch((error: any) => {
        logger.warn(
          `chat housekeeping failed chatKey=${controller.chatKey} err=${safeString(error?.message || error)}`,
        );
      });
      void controller.pollTyping().catch(() => {});
    }
    for (const controller of detachedControllers.values()) {
      void controller.housekeep().catch((error: any) => {
        logger.warn(
          `chat housekeeping failed chatKey=${controller.chatKey} err=${safeString(error?.message || error)}`,
        );
      });
      void controller.pollTyping().catch(() => {});
    }
  }, TYPING_POLL_INTERVAL_MS);
  const commandRows = getChatCommandRows();
  const getIdentity = () => loadIdentity(dataDir);
  const getController = (chatKey: string) => {
    let controller = controllers.get(chatKey);
    if (!controller) {
      controller = new ChatController(app, dataDir, chatKey, {
        logger,
        h,
      });
      controllers.set(chatKey, controller);
    }
    return controller;
  };
  const getDetachedController = (
    controllerKey: string,
    options?: {
      chatKey?: string;
      deliveryEnabled?: boolean;
      affectChatBinding?: boolean;
    },
  ) => {
    const statePath = path.join(
      dataDir,
      "cron-turns",
      safeString(controllerKey)
        .trim()
        .replace(/[^A-Za-z0-9._:-]+/g, "_"),
      "state.json",
    );
    const controllerChatKey =
      safeString(options?.chatKey).trim() || `cron:${controllerKey}`;
    let controller = detachedControllers.get(controllerKey);
    if (!controller) {
      controller = new ChatController(app, dataDir, controllerChatKey, {
        logger,
        h,
        deliveryEnabled: options?.deliveryEnabled,
        affectChatBinding: options?.affectChatBinding,
        statePath,
      });
      detachedControllers.set(controllerKey, controller);
      return controller;
    }
    if (controller.chatKey !== controllerChatKey) {
      controller.chatKey = controllerChatKey;
      controller.state.chatKey = controllerChatKey;
      void controller.session?.reload?.().catch(() => {});
    }
    return controller;
  };
  const findRuntimeBot = (platform: string, selfId: string) =>
    (Array.isArray(app.bots) ? app.bots : []).find(
      (bot: any) =>
        safeString(bot?.platform).trim() === safeString(platform).trim() &&
        safeString(bot?.selfId).trim() === safeString(selfId).trim(),
    );
  const hasInboundBeenAccepted = (
    chatKey: string,
    messageId: string,
    controller?: ChatController,
  ) => {
    const nextChatKey = safeString(chatKey).trim();
    const nextMessageId = safeString(messageId).trim();
    if (!nextChatKey || !nextMessageId) return false;
    if (controller?.state.processing?.incomingMessageId === nextMessageId) {
      return true;
    }
    const stored = getChatMessage(runtime.agentDir, nextChatKey, nextMessageId);
    return Boolean(safeString(stored?.processedAt || "").trim());
  };
  const waitForInboundAcceptance = async (
    chatKey: string,
    messageId: string,
    controller?: ChatController,
    timeoutMs = CHAT_INBOX_ACCEPT_TIMEOUT_MS,
  ) => {
    const nextChatKey = safeString(chatKey).trim();
    const nextMessageId = safeString(messageId).trim();
    if (!nextChatKey || !nextMessageId) return true;
    const deadline = Date.now() + Math.max(250, timeoutMs);
    while (Date.now() < deadline) {
      if (hasInboundBeenAccepted(nextChatKey, nextMessageId, controller)) {
        return true;
      }
      await wait(250);
    }
    return hasInboundBeenAccepted(nextChatKey, nextMessageId, controller);
  };
  const restoreQueuedSession = (payload: any) => {
    const session =
      payload && typeof payload === "object"
        ? JSON.parse(JSON.stringify(payload))
        : {};
    const platform = safeString(session?.platform || "").trim();
    const selfId = safeString(session?.selfId || "").trim();
    const bot = findRuntimeBot(platform, selfId);
    if (bot) session.bot = bot;
    return session;
  };

  const handleCommandSession = async (
    session: any,
    command: { name: string; argsText: string },
    identity: any,
  ) => {
    const platform = safeString(session?.platform || "").trim();
    const trust = trustOf(identity, platform, pickUserId(session));
    if (command.name !== "help" && !canRunCommand(trust, command.name)) {
      return { accepted: true, retry: false };
    }
    const chatKey = composeChatKey(
      platform,
      getChatId(session),
      safeString(session?.selfId || session?.bot?.selfId || "").trim(),
    );
    const messageId = pickMessageId(session);
    const replyToMessageId = pickReplyToMessageId(session);
    if (!chatKey) return { accepted: true, retry: false };
    const replySession = lookupReplySession(
      runtime.agentDir,
      chatKey,
      replyToMessageId,
    );

    if (command.name === "help") {
      const lines = commandRows.map(
        (entry) =>
          `/${entry.name}${entry.description ? ` — ${entry.description}` : ""}`,
      );
      await sendOutboxPayload(
        app,
        runtime.agentDir,
        {
          type: "text_delivery",
          createdAt: new Date().toISOString(),
          chatKey,
          text: lines.join("\n"),
          replyToMessageId: messageId || undefined,
          sessionId: replySession?.sessionId,
          sessionFile: replySession?.sessionFile,
        },
        h,
      ).catch(() => {});
      return { accepted: true, retry: false };
    }

    const controller = getController(chatKey);
    if (replySession?.sessionFile) {
      await controller
        .resumeSessionFile(replySession.sessionFile)
        .catch(() => {});
    }

    const text = `/${command.name}${command.argsText ? ` ${command.argsText}` : ""}`;
    try {
      await controller.runCommand(text, messageId, messageId);
      return { accepted: true, retry: false };
    } catch (error) {
      logger.warn(
        `chat command failed chatKey=${chatKey} command=${command.name} err=${safeString((error as any)?.message || error)}`,
      );
      return {
        accepted: false,
        retry: isTransientChatRuntimeError(error),
        errorMessage: safeString((error as any)?.message || error),
      };
    }
  };

  const handleChatTurnSession = async (
    session: any,
    elements: any[],
    identity: any,
    options?: { queued?: boolean },
  ) => {
    const decision = await shouldProcessText(session, elements, identity);
    if (!decision.allow) return { accepted: true, retry: false };
    const messageId = pickMessageId(session);
    const replyToMessageId = pickReplyToMessageId(session);
    const controller = getController(decision.chatKey);
    const replySession = lookupReplySession(
      runtime.agentDir,
      decision.chatKey,
      replyToMessageId,
    );
    if (replySession?.sessionFile) {
      await controller
        .resumeSessionFile(replySession.sessionFile)
        .catch(() => {});
    }
    const { attachments, failures } = await extractInboundAttachments(
      elements,
      chatStateDir(dataDir, decision.chatKey),
    );
    if (failures.length) {
      let telegramDebug = "";
      if (safeString(session?.platform || "").trim() === "telegram") {
        try {
          const detail = await buildTelegramInboundMediaDebug(session);
          if (detail) telegramDebug = ` telegram=${JSON.stringify(detail)}`;
        } catch (error: any) {
          telegramDebug = ` telegramDebugErr=${safeString(error?.message || error)}`;
        }
      }
      logger.warn(
        `chat inbound media unresolved chatKey=${decision.chatKey} messageId=${messageId || "unknown"} failures=${JSON.stringify(failures)}${telegramDebug}`,
      );
    }
    const inboundAttachmentNotice = buildInboundAttachmentNotice(failures);
    const promptBody = inboundAttachmentNotice
      ? `${decision.text}\n\n${inboundAttachmentNotice}`
      : decision.text;
    enqueueChatPromptContext({
      source: "chat-bridge",
      sentAt: Number.isFinite(Number(session?.timestamp))
        ? Number(session.timestamp)
        : Date.now(),
      chatKey: decision.chatKey,
      chatName:
        pickChatName(session) ||
        (getChatType(session) === "private" ? pickSenderNickname(session) : ""),
      chatType: getChatType(session),
      userId: pickUserId(session),
      nickname: pickSenderNickname(session),
      identity: trustOf(
        identity,
        safeString(session?.platform || "").trim(),
        pickUserId(session),
      ),
      replyToMessageId: replyToMessageId || undefined,
      attachedFiles: attachments
        .filter((item) => item?.kind === "file")
        .map((item) => ({ name: item.name, path: item.path })),
    });
    const mode = controller.hasActiveTurn() ? "steer" : "prompt";
    const handleTurnFailure = async (error: any) => {
      const errorMessage = safeString((error as any)?.message || error);
      const transientFailure = isTransientChatRuntimeError(errorMessage);
      logger.warn(
        `chat turn failed chatKey=${decision.chatKey} transient=${transientFailure} err=${errorMessage}`,
      );
      if (transientFailure) {
        if (!options?.queued) {
          setTimeout(() => {
            void controller.recoverIfNeeded().catch((recoverError) => {
              logger.warn(
                `chat recovery failed chatKey=${decision.chatKey} err=${safeString((recoverError as any)?.message || recoverError)}`,
              );
            });
          }, 1000);
        }
        return { transientFailure, errorMessage };
      }
      void sendOutboxPayload(
        app,
        runtime.agentDir,
        {
          type: "text_delivery",
          createdAt: new Date().toISOString(),
          chatKey: decision.chatKey,
          text: `Chat bridge error: ${errorMessage || "chat_bridge_turn_failed"}`,
          replyToMessageId: messageId || undefined,
          sessionId: replySession?.sessionId,
          sessionFile: replySession?.sessionFile,
        },
        h,
      ).catch(() => {});
      void controller.clearProcessingState().catch(() => {});
      return { transientFailure, errorMessage };
    };
    const turnPromise = controller.runTurn(
      {
        text: promptBody,
        attachments,
        replyToMessageId: messageId,
        incomingMessageId: messageId,
      },
      mode,
    );
    if (!options?.queued) {
      void turnPromise.catch((error) => {
        void handleTurnFailure(error);
      });
      return { accepted: true, retry: false };
    }
    let failure: { transientFailure: boolean; errorMessage: string } | null = null;
    void turnPromise.catch(async (error) => {
      failure = await handleTurnFailure(error);
    });
    const accepted = await waitForInboundAcceptance(
      decision.chatKey,
      messageId,
      controller,
    );
    if (accepted) return { accepted: true, retry: false };
    if (failure) {
      return {
        accepted: false,
        retry: failure.transientFailure,
        errorMessage: failure.errorMessage,
      };
    }
    return {
      accepted: false,
      retry: true,
      errorMessage: "chat_turn_not_accepted",
    };
  };

  const drainChatInbox = async () => {
    for (const filePath of listPendingChatInboxFiles(runtime.agentDir)) {
      let claimedPath = "";
      try {
        claimedPath = claimChatInboxFile(runtime.agentDir, filePath);
      } catch {
        continue;
      }
      if (!claimedPath) continue;
      const envelope = readChatInboxItem(claimedPath);
      if (!envelope) {
        completeChatInboxFile(claimedPath);
        continue;
      }
      const nextAttemptAt = Date.parse(safeString(envelope.nextAttemptAt || "").trim());
      if (Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now()) {
        restoreChatInboxFile(runtime.agentDir, claimedPath, envelope);
        continue;
      }
      try {
        const queuedSession = restoreQueuedSession(envelope.session);
        const queuedElements = Array.isArray(envelope.elements) ? envelope.elements : [];
        if (
          envelope.chatKey &&
          envelope.messageId &&
          hasInboundBeenAccepted(envelope.chatKey, envelope.messageId)
        ) {
          completeChatInboxFile(claimedPath);
          continue;
        }
        const identity = getIdentity();
        const command = parseInboundCommand(
          queuedSession,
          elementsToText(queuedElements),
          commandRows,
        );
        const result = command
          ? await handleCommandSession(queuedSession, command, identity)
          : await handleChatTurnSession(queuedSession, queuedElements, identity, {
              queued: true,
            });
        if (result?.accepted || result?.retry === false) {
          completeChatInboxFile(claimedPath);
          continue;
        }
        requeueChatInboxFile(runtime.agentDir, claimedPath, envelope, {
          delayMs: computeChatInboxRetryDelay(envelope.attemptCount + 1),
          error: safeString(result?.errorMessage || "chat_inbound_retry_needed"),
        });
      } catch (error) {
        logger.warn(
          `chat inbox drain failed file=${claimedPath} err=${safeString((error as any)?.message || error)}`,
        );
        requeueChatInboxFile(runtime.agentDir, claimedPath, envelope, {
          delayMs: computeChatInboxRetryDelay(envelope.attemptCount + 1),
          error: safeString((error as any)?.message || error),
        });
      }
    }
  };

  app.on("message", (session: any) => {
    void (async () => {
      const identity = getIdentity();
      const elements = ensureSessionElements(session);
      try {
        persistInboundMessage(
          runtime.agentDir,
          session,
          elements,
          identity,
          trustOf,
        );
        const platform = safeString(session?.platform || "").trim();
        const botId = safeString(
          session?.selfId || session?.bot?.selfId || "",
        ).trim();
        const chatKey = composeChatKey(platform, getChatId(session), botId);
        const messageId = pickMessageId(session);
        if (chatKey && messageId) {
          enqueueChatInboxItem(runtime.agentDir, {
            chatKey,
            messageId,
            session,
            elements,
          });
        }
        const text = elementsToText(elements);
        if (chatKey && text) {
          appendChatLog(runtime.agentDir, {
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
      } catch (error: any) {
        logger.warn(
          `chat inbound save failed err=${safeString(error?.message || error)}`,
        );
      }

      const command = parseInboundCommand(
        session,
        elementsToText(elements),
        commandRows,
      );
      if (command) {
        await handleCommandSession(session, command, identity);
      } else {
        await handleChatTurnSession(session, elements, identity);
      }
    })().catch((error: any) => {
      logger.warn(
        `chat inbound handling failed err=${safeString(error?.message || error)}`,
      );
    });
  });

  inboxPollTimer = setInterval(() => {
    void drainChatInbox().catch((error: any) => {
      logger.warn(
        `chat inbox polling failed err=${safeString(error?.message || error)}`,
      );
    });
  }, CHAT_INBOX_POLL_INTERVAL_MS);

  app.on("bot-status-updated", (bot: any) => {
    if (bot?.status !== 1) return;
    void syncTelegramCommands(app, logger, commandRows);
  });

  const rpcSocketPath = chatRpcSocketPath(runtime.agentDir);
  try {
    fs.rmSync(rpcSocketPath, { force: true });
  } catch {}
  ensureDir(path.dirname(rpcSocketPath));
  const rpcServer = net.createServer((socket) => {
    let buffer = "";
    const writeLine = (payload: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        void (async () => {
          let command: any;
          try {
            command = JSON.parse(line);
          } catch {
            writeLine({ success: false, error: "invalid_json" });
            return;
          }
          try {
            const type = safeString(command?.type).trim();
            if (type === "send_chat") {
              await sendOutboxPayload(
                app,
                runtime.agentDir,
                command?.payload,
                h,
              );
              writeLine({ success: true, data: { delivered: true } });
              return;
            }
            if (type === "run_chat_turn") {
              const payload = command?.payload || {};
              const chatKey = safeString(payload.chatKey).trim();
              const text = safeString(payload.text).trim();
              const sessionFile =
                safeString(payload.sessionFile).trim() || undefined;
              const controllerKey =
                safeString(payload.controllerKey).trim() || "default";
              const deliveryEnabled = payload?.deliveryEnabled !== false;
              const affectChatBinding = payload?.affectChatBinding !== false;
              if (!text) throw new Error("chat_rpc_text_required");
              const controller =
                chatKey &&
                controllerKey === "default" &&
                deliveryEnabled &&
                affectChatBinding
                  ? getController(chatKey)
                  : getDetachedController(controllerKey, {
                      chatKey,
                      deliveryEnabled,
                      affectChatBinding,
                    });
              const result = await controller.runTurn(
                {
                  text,
                  attachments: [],
                  sessionFile,
                },
                "prompt",
              );
              writeLine({ success: true, data: result || { delivered: true } });
              return;
            }
            if (type === "bridge_eval") {
              const payload = command?.payload || {};
              const startedAt = Date.now();
              const currentChatKey =
                safeString(payload.currentChatKey).trim() || undefined;
              const requestId =
                safeString(payload.requestId).trim() || undefined;
              const code = safeString(payload.code);
              const runtimeContext = createChatBridgeRuntime({
                app,
                agentDir: runtime.agentDir,
                dataDir,
                currentChatKey,
                h,
                requestId,
                sessionId: safeString(payload.sessionId).trim() || undefined,
                sessionFile:
                  safeString(payload.sessionFile).trim() || undefined,
              });
              let auditPath = "";
              try {
                const result = await executeChatBridgeCode({
                  code,
                  context: runtimeContext,
                  timeoutMs: payload.timeoutMs,
                  filename: `${currentChatKey || "chat"}:${requestId || "bridge"}.ts`,
                });
                auditPath = appendChatBridgeAudit(runtime.agentDir, {
                  timestamp: new Date().toISOString(),
                  ok: true,
                  currentChatKey,
                  requestId,
                  sessionId: safeString(payload.sessionId).trim() || undefined,
                  sessionFile:
                    safeString(payload.sessionFile).trim() || undefined,
                  timeoutMs: result.timeoutMs,
                  durationMs: Date.now() - startedAt,
                  code,
                  result: result.value,
                });
                writeLine({
                  success: true,
                  data: {
                    ok: true,
                    currentChatKey,
                    requestId,
                    timeoutMs: result.timeoutMs,
                    durationMs: Date.now() - startedAt,
                    auditPath,
                    value: result.value,
                    text: renderChatBridgeResult(result.value),
                  },
                });
                return;
              } catch (error: any) {
                auditPath = appendChatBridgeAudit(runtime.agentDir, {
                  timestamp: new Date().toISOString(),
                  ok: false,
                  currentChatKey,
                  requestId,
                  sessionId: safeString(payload.sessionId).trim() || undefined,
                  sessionFile:
                    safeString(payload.sessionFile).trim() || undefined,
                  durationMs: Date.now() - startedAt,
                  code,
                  error: safeString(
                    error?.stack || error?.message || error,
                  ).trim(),
                });
                throw new Error(
                  `${safeString(error?.message || error).trim() || "chat_bridge_failed"}${auditPath ? `\naudit=${auditPath}` : ""}`,
                );
              }
            }
            writeLine({
              success: false,
              error: "unsupported_server_request",
            });
            return;
          } catch (error: any) {
            writeLine({
              success: false,
              error: safeString(error?.message || error) || "chat_rpc_failed",
            });
          }
        })();
      }
    });
  });

  await app.start();
  await new Promise<void>((resolve, reject) => {
    rpcServer.once("error", reject);
    rpcServer.listen(rpcSocketPath, () => {
      rpcServer.off("error", reject);
      resolve();
    });
  });
  await syncTelegramCommands(app, logger, commandRows);
  logger.info(
    `chat bridge started bots=${JSON.stringify(app.bots.map((bot: any) => ({ platform: bot.platform, selfId: bot.selfId, status: bot.status })))}`,
  );

  for (const item of listChatStateFiles(path.join(dataDir, "chats"))) {
    const controller = getController(item.chatKey);
    void controller.recoverIfNeeded().catch((error) => {
      logger.warn(
        `chat recovery failed chatKey=${item.chatKey} err=${safeString((error as any)?.message || error)}`,
      );
    });
  }
  for (const item of listDetachedControllerStateFiles(path.join(dataDir, "cron-turns"))) {
    const controller = getDetachedController(item.controllerKey, {
      chatKey: item.chatKey,
      deliveryEnabled: false,
      affectChatBinding: false,
    });
    void controller.recoverIfNeeded().catch((error) => {
      logger.warn(
        `detached chat recovery failed controllerKey=${item.controllerKey} err=${safeString((error as any)?.message || error)}`,
      );
    });
  }
  void drainChatInbox().catch((error: any) => {
    logger.warn(
      `chat inbox startup drain failed err=${safeString(error?.message || error)}`,
    );
  });

  const shutdown = async () => {
    clearInterval(typingPollTimer);
    if (inboxPollTimer) clearInterval(inboxPollTimer);
    for (const controller of controllers.values()) controller.dispose();
    for (const controller of detachedControllers.values()) controller.dispose();
    try {
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
    } catch {}
    try {
      fs.rmSync(rpcSocketPath, { force: true });
    } catch {}
    try {
      await app.stop();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { app, options };
}

async function main() {
  await startChatBridge();
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    logger.error(String(error?.message || error || "rin_chat_failed"));
    process.exit(1);
  });
}
