#!/usr/bin/env node
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { canRunCommand } from "../chat-bridge/policy.js";
import { enqueueKoishiPromptContext } from "../chat-bridge/prompt-context.js";
import {
  chatStateDir,
  listChatStateFiles,
} from "../chat-bridge/session-binding.js";
import { getKoishiChatCommandRows, syncTelegramCommands } from "./boot.js";
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
import {
  KoishiChatController,
  loadKoishiSettings,
  normalizeKoishiIdleToolProgressConfig,
} from "./controller.js";
import { appendKoishiChatLog } from "./chat-log.js";
import { shouldProcessText } from "./decision.js";
import {
  composeChatKey,
  loadIdentity,
  materializeKoishiConfig,
  trustOf,
} from "./support.js";
import { koishiRpcSocketPath } from "./rpc.js";
import { sendOutboxPayload } from "./transport.js";

const require = createRequire(import.meta.url);
const { Loader, Logger, h } = require("koishi") as {
  Loader: any;
  Logger: any;
  h: any;
};

const logger = new Logger("rin-koishi");
const RIN_KOISHI_SETTINGS_PATH_ENV = "RIN_KOISHI_SETTINGS_PATH";
const TYPING_POLL_INTERVAL_MS = 4000;

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
      width: Number.isFinite(Number(item?.width)) ? Number(item.width) : undefined,
      height: Number.isFinite(Number(item?.height)) ? Number(item.height) : undefined,
    })),
    message?.document
      ? {
          kind: "document",
          fileId: safeString(message.document?.file_id || "").trim(),
          fileUniqueId:
            safeString(message.document?.file_unique_id || "").trim() || undefined,
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
        const file = await getFile.call(session.bot.internal, { file_id: item.fileId });
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
          error: safeString(error?.description || error?.message || error).trim(),
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

export async function startKoishi(
  options: { additionalExtensionPaths?: string[] } = {},
) {
  const runtime = resolveRuntimeProfile();
  const dataDir = path.join(runtime.agentDir, "data");
  const settingsPath =
    process.env[RIN_KOISHI_SETTINGS_PATH_ENV]?.trim() ||
    path.join(runtime.agentDir, "settings.json");
  const configPath = path.join(dataDir, "koishi.yml");

  applyRuntimeProfileEnvironment(runtime);
  if (process.cwd() !== runtime.cwd) process.chdir(runtime.cwd);
  ensureDir(dataDir);

  const settings = loadKoishiSettings(settingsPath);
  const idleToolProgressConfig = normalizeKoishiIdleToolProgressConfig(settings);

  materializeKoishiConfig(configPath, settings);

  const loader = new Loader();
  const previousCwd = process.cwd();
  if (previousCwd !== dataDir) process.chdir(dataDir);
  try {
    await loader.init(configPath);
    loader.envFiles = [];
    await loader.readConfig(true);
  } finally {
    if (process.cwd() !== previousCwd) process.chdir(previousCwd);
  }

  const app = await loader.createApp();
  const controllers = new Map<string, KoishiChatController>();
  const detachedControllers = new Map<string, KoishiChatController>();
  const typingPollTimer = setInterval(() => {
    for (const controller of controllers.values()) {
      void controller.pollTyping().catch(() => {});
    }
  }, TYPING_POLL_INTERVAL_MS);
  const commandRows = getKoishiChatCommandRows();
  const getIdentity = () => loadIdentity(dataDir);
  const getController = (chatKey: string) => {
    let controller = controllers.get(chatKey);
    if (!controller) {
      controller = new KoishiChatController(app, dataDir, chatKey, {
        logger,
        h,
        idleToolProgressConfig,
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
      safeString(controllerKey).trim().replace(/[^A-Za-z0-9._:-]+/g, "_"),
      "state.json",
    );
    const controllerChatKey =
      safeString(options?.chatKey).trim() || `cron:${controllerKey}`;
    let controller = detachedControllers.get(controllerKey);
    if (!controller) {
      controller = new KoishiChatController(app, dataDir, controllerChatKey, {
        logger,
        h,
        deliveryEnabled: options?.deliveryEnabled,
        affectChatBinding: options?.affectChatBinding,
        statePath,
        idleToolProgressConfig,
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

  app.middleware(async (session: any, next: () => Promise<any>) => {
    try {
      const elements = ensureSessionElements(session);
      persistInboundMessage(
        runtime.agentDir,
        session,
        elements,
        getIdentity(),
        trustOf,
      );
      const platform = safeString(session?.platform || "").trim();
      const botId = safeString(
        session?.selfId || session?.bot?.selfId || "",
      ).trim();
      const chatKey = composeChatKey(platform, getChatId(session), botId);
      const text = elementsToText(elements);
      if (chatKey && text) {
        appendKoishiChatLog(runtime.agentDir, {
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
        `koishi inbound save failed err=${safeString(error?.message || error)}`,
      );
    }
    return await next();
  }, true);

  app.middleware(async (session: any, next: () => Promise<any>) => {
    // Let Koishi's native command middleware short-circuit command messages.
    // This middleware only handles ordinary chat turns that continue past it.
    const identity = getIdentity();
    const elements = ensureSessionElements(session);
    const decision = await shouldProcessText(session, elements, identity);
    if (!decision.allow) return await next();
    const messageId = pickMessageId(session);
    const replyToMessageId = pickReplyToMessageId(session);
    const controller = getController(decision.chatKey);
    const replySession = lookupReplySession(
      runtime.agentDir,
      decision.chatKey,
      replyToMessageId,
    );
    if (replySession?.sessionFile)
      await controller
        .resumeSessionFile(replySession.sessionFile)
        .catch(() => {});
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
        `koishi inbound media unresolved chatKey=${decision.chatKey} messageId=${messageId || "unknown"} failures=${JSON.stringify(failures)}${telegramDebug}`,
      );
    }
    const inboundAttachmentNotice = buildInboundAttachmentNotice(failures);
    const promptBody = inboundAttachmentNotice
      ? `${decision.text}\n\n${inboundAttachmentNotice}`
      : decision.text;
    enqueueKoishiPromptContext({
      source: "koishi-bridge",
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
    void controller
      .runTurn(
        {
          text: promptBody,
          attachments,
          replyToMessageId: messageId,
          incomingMessageId: messageId,
        },
        mode,
      )
      .catch((error) => {
        const errorMessage = safeString((error as any)?.message || error);
        const transientFailure =
          /rin_timeout:|rin_disconnected:|rin_tui_not_connected|koishi_controller_disposed/.test(
            errorMessage,
          );
        logger.warn(
          `koishi turn failed chatKey=${decision.chatKey} transient=${transientFailure} err=${errorMessage}`,
        );
        if (transientFailure) {
          setTimeout(() => {
            void controller.recoverIfNeeded().catch((recoverError) => {
              logger.warn(
                `koishi recovery failed chatKey=${decision.chatKey} err=${safeString((recoverError as any)?.message || recoverError)}`,
              );
            });
          }, 1000);
          return;
        }
        void sendOutboxPayload(
          app,
          runtime.agentDir,
          {
            type: "text_delivery",
            createdAt: new Date().toISOString(),
            chatKey: decision.chatKey,
            text: `Koishi error: ${errorMessage || "koishi_turn_failed"}`,
            replyToMessageId: messageId || undefined,
            sessionId: replySession?.sessionId,
            sessionFile: replySession?.sessionFile,
          },
          h,
        ).catch(() => {});
      });
    return "";
  });

  for (const item of commandRows) {
    app
      .command(`${item.name} [args:text]`, item.description || "", {
        slash: true,
      })
      .action(async ({ session }: any, argsText: any) => {
        const identity = getIdentity();
        const platform = safeString(session?.platform || "").trim();
        const trust = trustOf(identity, platform, pickUserId(session));
        if (item.name !== "help" && !canRunCommand(trust, item.name)) return "";
        const chatKey = composeChatKey(
          platform,
          getChatId(session),
          safeString(session?.selfId || session?.bot?.selfId || "").trim(),
        );
        const messageId = pickMessageId(session);
        const replyToMessageId = pickReplyToMessageId(session);
        if (!chatKey) return "";
        const replySession = lookupReplySession(
          runtime.agentDir,
          chatKey,
          replyToMessageId,
        );

        if (item.name === "help") {
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
          return "";
        }

        const controller = getController(chatKey);
        if (replySession?.sessionFile)
          await controller
            .resumeSessionFile(replySession.sessionFile)
            .catch(() => {});

        const text = `/${item.name}${safeString(argsText).trim() ? ` ${safeString(argsText).trim()}` : ""}`;
        await controller.runCommand(text, messageId, messageId).catch((error) => {
          logger.warn(
            `koishi command failed chatKey=${chatKey} command=${item.name} err=${safeString((error as any)?.message || error)}`,
          );
        });
        return "";
      });
  }

  app.on("bot-status-updated", (bot: any) => {
    if (bot?.status !== 1) return;
    void syncTelegramCommands(app, logger, commandRows);
  });

  const rpcSocketPath = koishiRpcSocketPath(runtime.agentDir);
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
              await sendOutboxPayload(app, runtime.agentDir, command?.payload, h);
              writeLine({ success: true, data: { delivered: true } });
              return;
            }
            if (type === "run_chat_turn") {
              const payload = command?.payload || {};
              const chatKey = safeString(payload.chatKey).trim();
              const text = safeString(payload.text).trim();
              const sessionFile = safeString(payload.sessionFile).trim() || undefined;
              const controllerKey = safeString(payload.controllerKey).trim() || "default";
              const deliveryEnabled = payload?.deliveryEnabled !== false;
              const affectChatBinding = payload?.affectChatBinding !== false;
              if (!text) throw new Error("koishi_rpc_text_required");
              const controller = chatKey && controllerKey === "default" && deliveryEnabled && affectChatBinding
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
            writeLine({
              success: false,
              error: "unsupported_server_request",
            });
            return;
          } catch (error: any) {
            writeLine({
              success: false,
              error: safeString(error?.message || error) || "koishi_rpc_failed",
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
    `koishi started bots=${JSON.stringify(app.bots.map((bot: any) => ({ platform: bot.platform, selfId: bot.selfId, status: bot.status })))}`,
  );

  for (const item of listChatStateFiles(path.join(dataDir, "chats"))) {
    const controller = getController(item.chatKey);
    void controller.recoverIfNeeded().catch((error) => {
      logger.warn(
        `koishi recovery failed chatKey=${item.chatKey} err=${safeString((error as any)?.message || error)}`,
      );
    });
  }

  const shutdown = async () => {
    clearInterval(typingPollTimer);
    for (const controller of controllers.values()) controller.dispose();
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
  await startKoishi();
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    logger.error(String(error?.message || error || "rin_koishi_failed"));
    process.exit(1);
  });
}
