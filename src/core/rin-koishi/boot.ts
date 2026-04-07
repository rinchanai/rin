import fs from "node:fs";

import { chatOutboxDir } from "../rin-lib/chat-outbox.js";
import { listJsonFiles, safeString } from "./chat-helpers.js";
import { readJsonFile } from "./support.js";
import { sendOutboxPayload } from "./transport.js";

export function buildAllowedCommandRows(
  rpcCommands: Array<{ name: string; description?: string }>,
) {
  const allowedCommandNames = new Set([
    "new",
    "compact",
    "reload",
    "session",
    "resume",
    "model",
  ]);
  return [
    { name: "help", description: "Show available commands" },
    ...rpcCommands.filter((item) => allowedCommandNames.has(item.name)),
  ];
}

export function buildTelegramCommandPayload(
  commandRows: Array<{ name: string; description?: string }>,
) {
  const payload: Array<{ command: string; description: string }> = [];
  const seen = new Set<string>();

  for (const item of commandRows) {
    const rawName = safeString(item?.name).trim();
    if (!/^[\w-]{1,32}$/.test(rawName)) continue;

    const command = rawName.toLowerCase().replace(/[^\w]/g, "_");
    if (!command || seen.has(command)) continue;

    payload.push({
      command,
      description: safeString(item?.description).trim() || rawName,
    });
    seen.add(command);
  }

  return payload;
}

export function buildTelegramCommandClearScopes() {
  return [
    { type: "all_private_chats" },
    { type: "all_group_chats" },
    { type: "all_chat_administrators" },
  ];
}

export async function syncTelegramCommands(
  app: any,
  logger: any,
  commandRows: Array<{ name: string; description?: string }> = [],
) {
  const commander = app.$commander;
  const payload = buildTelegramCommandPayload(commandRows);
  const clearScopes = buildTelegramCommandClearScopes();

  for (const bot of Array.isArray(app.bots) ? app.bots : []) {
    if (safeString(bot?.platform) !== "telegram") continue;

    try {
      if (typeof bot?.internal?.setMyCommands === "function") {
        if (typeof bot?.internal?.deleteMyCommands === "function") {
          for (const scope of clearScopes) {
            await bot.internal.deleteMyCommands({ scope });
          }
        }

        if (payload.length) {
          await bot.internal.setMyCommands({ commands: payload });
        }
        continue;
      }

      if (
        commander?.updateCommands &&
        typeof bot?.updateCommands === "function"
      ) {
        await commander.updateCommands(bot);
      }
    } catch (error: any) {
      logger.warn(
        `koishi command sync failed platform=${safeString(bot?.platform)} selfId=${safeString(bot?.selfId)} err=${safeString(error?.message || error)}`,
      );
    }
  }
}

export async function drainKoishiOutbox(
  app: any,
  agentDir: string,
  h: any,
  logger: any,
) {
  for (const filePath of listJsonFiles(chatOutboxDir(agentDir))) {
    let payload: any = null;
    try {
      payload = readJsonFile<any>(filePath, null);
      await sendOutboxPayload(app, payload, h);
    } catch (error: any) {
      logger.warn(
        `koishi outbox failed file=${filePath} err=${safeString(error?.message || error)}`,
      );
    } finally {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {}
    }
  }
}
