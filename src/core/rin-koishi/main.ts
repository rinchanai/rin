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
import {
  chatStateDir,
  listChatStateFiles,
} from "../chat-bridge/session-binding.js";
import { buildAllowedCommandRows, syncTelegramCommands } from "./boot.js";
import {
  ensureDir,
  extractInboundAttachments,
  getChatId,
  lookupReplySession,
  persistInboundMessage,
  pickChatName,
  pickMessageId,
  pickReplyToMessageId,
  pickSenderNickname,
  pickUserId,
  safeString,
  wrapKoishiBridgePrompt,
} from "./chat-helpers.js";
import {
  KoishiChatController,
  loadKoishiSettings,
  normalizeKoishiIdleToolProgressConfig,
} from "./controller.js";
import { appendKoishiChatLog } from "./chat-log.js";
import { discoverRpcCommands, shouldProcessText } from "./decision.js";
import {
  composeChatKey,
  loadIdentity,
  materializeKoishiConfig,
  trustOf,
} from "./support.js";
import { koishiRpcSocketPath } from "./rpc.js";
import {
  recordDeliveredAssistantMessages,
  sendOutboxPayload,
  sendText,
} from "./transport.js";

const require = createRequire(import.meta.url);
const { Loader, Logger, h } = require("koishi") as {
  Loader: any;
  Logger: any;
  h: any;
};

const logger = new Logger("rin-koishi");
const RIN_KOISHI_SETTINGS_PATH_ENV = "RIN_KOISHI_SETTINGS_PATH";

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
  const registeredCommandNames = new Set<string>();
  const commandRows = buildAllowedCommandRows(await discoverRpcCommands());
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
  const getDetachedController = (controllerKey: string) => {
    let controller = detachedControllers.get(controllerKey);
    if (!controller) {
      const statePath = path.join(
        dataDir,
        "cron-turns",
        safeString(controllerKey).trim().replace(/[^A-Za-z0-9._:-]+/g, "_"),
        "state.json",
      );
      controller = new KoishiChatController(app, dataDir, `cron:${controllerKey}`, {
        logger,
        h,
        deliveryEnabled: false,
        statePath,
        idleToolProgressConfig,
      });
      detachedControllers.set(controllerKey, controller);
    }
    return controller;
  };

  app.middleware(async (session: any, next: () => Promise<any>) => {
    try {
      persistInboundMessage(runtime.agentDir, session, getIdentity(), trustOf);
      const platform = safeString(session?.platform || "").trim();
      const botId = safeString(
        session?.selfId || session?.bot?.selfId || "",
      ).trim();
      const chatKey = composeChatKey(platform, getChatId(session), botId);
      const text = safeString(
        session?.stripped?.content || session?.content || "",
      ).trim();
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

  for (const item of commandRows) {
    registeredCommandNames.add(item.name);
    app
      .command(`${item.name} [args:text]`, item.description || "", {
        slash: true,
      })
      .action(async ({ session }: any, argsText: any) => {
        const identity = getIdentity();
        const platform = safeString(session?.platform || "").trim();
        const trust = trustOf(identity, platform, pickUserId(session));
        if (item.name !== "help" && !canRunCommand(trust, item.name)) return "";
        try {
          session.__rinKoishiCommandHandled = true;
        } catch {}
        const chatKey = composeChatKey(
          platform,
          getChatId(session),
          safeString(session?.selfId || session?.bot?.selfId || "").trim(),
        );
        const messageId = pickMessageId(session);
        const replyToMessageId = pickReplyToMessageId(session);
        if (!chatKey) return "";

        if (item.name === "help") {
          const lines = commandRows.map(
            (entry) =>
              `/${entry.name}${entry.description ? ` — ${entry.description}` : ""}`,
          );
          await sendText(app, chatKey, lines.join("\n"), h, messageId)
            .then((deliveryResult) => {
              appendKoishiChatLog(runtime.agentDir, {
                timestamp: new Date().toISOString(),
                chatKey,
                role: "assistant",
                text: lines.join("\n"),
                replyToMessageId: messageId || undefined,
              });
              recordDeliveredAssistantMessages(runtime.agentDir, {
                chatKey,
                deliveryResult,
                text: lines.join("\n"),
                rawContent: lines.join("\n"),
                replyToMessageId: messageId || undefined,
              });
            })
            .catch(() => {});
          return "";
        }

        const controller = getController(chatKey);
        const replySession = lookupReplySession(
          runtime.agentDir,
          chatKey,
          replyToMessageId,
        );
        if (replySession?.sessionFile)
          await controller
            .resumeSessionFile(replySession.sessionFile)
            .catch(() => {});

        const text = `/${item.name}${safeString(argsText).trim() ? ` ${safeString(argsText).trim()}` : ""}`;
        void controller
          .runCommand(text, messageId, messageId)
          .catch((error) => {
            logger.warn(
              `koishi command failed chatKey=${chatKey} command=${item.name} err=${safeString((error as any)?.message || error)}`,
            );
          });
        return "";
      });
  }

  app.middleware(async (session: any, next: () => Promise<any>) => {
    if (session?.__rinKoishiCommandHandled) return "";
    const identity = getIdentity();
    const decision = await shouldProcessText(
      session,
      identity,
      registeredCommandNames,
    );
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
    const attachments = await extractInboundAttachments(
      session,
      chatStateDir(dataDir, decision.chatKey),
    );
    const text = wrapKoishiBridgePrompt(decision.text, {
      source: "koishi-bridge",
      sentAt: Number.isFinite(Number(session?.timestamp))
        ? Number(session.timestamp)
        : Date.now(),
      chatKey: decision.chatKey,
      chatName: pickChatName(session),
      userId: pickUserId(session),
      nickname: pickSenderNickname(session),
      identity: trustOf(
        identity,
        safeString(session?.platform || "").trim(),
        pickUserId(session),
      ),
      replyToMessageId: replyToMessageId || undefined,
    });
    void controller
      .runTurn(
        {
          text,
          attachments,
          replyToMessageId: messageId,
          incomingMessageId: messageId,
        },
        "interrupt_prompt",
      )
      .catch((error) => {
        const errorMessage = safeString((error as any)?.message || error);
        logger.warn(
          `koishi turn failed chatKey=${decision.chatKey} err=${errorMessage}`,
        );
        const errorText =
          /rin_timeout:|rin_disconnected:|rin_tui_not_connected/.test(
            errorMessage,
          )
            ? "Koishi bridge timed out while forwarding the turn. Please retry in a moment."
            : `Koishi error: ${errorMessage || "koishi_turn_failed"}`;
        appendKoishiChatLog(runtime.agentDir, {
          timestamp: new Date().toISOString(),
          chatKey: decision.chatKey,
          role: "assistant",
          text: errorText,
          replyToMessageId: messageId || undefined,
        });
        void sendText(app, decision.chatKey, errorText, h, messageId)
          .then((deliveryResult) => {
            recordDeliveredAssistantMessages(runtime.agentDir, {
              chatKey: decision.chatKey,
              deliveryResult,
              text: errorText,
              rawContent: errorText,
              replyToMessageId: messageId || undefined,
            });
          })
          .catch(() => {});
      });
    return "";
  }, true);

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
              if (!text) throw new Error("koishi_rpc_text_required");
              const controller = chatKey
                ? getController(chatKey)
                : getDetachedController(controllerKey);
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
