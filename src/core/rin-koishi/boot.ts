import fs from "node:fs";
import path from "node:path";

import { chatOutboxDir } from "../rin-lib/chat-outbox.js";
import { listJsonFiles, safeString } from "./chat-helpers.js";
import { readJsonFile } from "./support.js";
import { sendOutboxPayload } from "./transport.js";

export type KoishiChatCommandRow = {
  name: string;
  description?: string;
};

const KOISHI_CHAT_COMMAND_ROWS: readonly KoishiChatCommandRow[] = [
  { name: "help", description: "Show available commands" },
  { name: "abort", description: "Abort current operation" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact the current session" },
  { name: "reload", description: "Reload extensions, prompts, skills, and themes" },
  { name: "session", description: "Show current session status" },
  { name: "resume", description: "Resume a previous session" },
  { name: "model", description: "Show or change the current model" },
];

const TELEGRAM_COMMAND_LANGUAGE_CODES = ["en", "zh"] as const;

export function getKoishiChatCommandRows(): KoishiChatCommandRow[] {
  return KOISHI_CHAT_COMMAND_ROWS.map((item) => ({ ...item }));
}

export function buildTelegramCommandPayload(
  commandRows: KoishiChatCommandRow[],
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
  commandRows: KoishiChatCommandRow[] = [],
) {
  const commander = app.$commander;
  const payload = buildTelegramCommandPayload(commandRows);
  const clearScopes = buildTelegramCommandClearScopes();

  for (const bot of Array.isArray(app.bots) ? app.bots : []) {
    if (safeString(bot?.platform) !== "telegram") continue;

    try {
      if (typeof bot?.internal?.setMyCommands === "function") {
        if (typeof bot?.internal?.deleteMyCommands === "function") {
          await bot.internal.deleteMyCommands({});
          for (const languageCode of TELEGRAM_COMMAND_LANGUAGE_CODES) {
            await bot.internal.deleteMyCommands({ language_code: languageCode });
          }
          for (const scope of clearScopes) {
            await bot.internal.deleteMyCommands({ scope });
            for (const languageCode of TELEGRAM_COMMAND_LANGUAGE_CODES) {
              await bot.internal.deleteMyCommands({
                scope,
                language_code: languageCode,
              });
            }
          }
        }

        if (payload.length) {
          await bot.internal.setMyCommands({ commands: payload });
          for (const languageCode of TELEGRAM_COMMAND_LANGUAGE_CODES) {
            await bot.internal.setMyCommands({
              commands: payload,
              language_code: languageCode,
            });
          }
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
  const outboxDir = chatOutboxDir(agentDir);
  const failedDir = path.join(outboxDir, "failed");
  const processingDir = path.join(outboxDir, "processing");
  for (const filePath of listJsonFiles(outboxDir)) {
    let payload: any = null;
    let claimedPath = "";
    try {
      fs.mkdirSync(processingDir, { recursive: true });
      claimedPath = path.join(processingDir, path.basename(filePath));
      fs.renameSync(filePath, claimedPath);
    } catch {
      continue;
    }
    try {
      payload = readJsonFile<any>(claimedPath, null);
      await sendOutboxPayload(app, agentDir, payload, h);
      fs.rmSync(claimedPath, { force: true });
    } catch (error: any) {
      logger.warn(
        `koishi outbox failed file=${claimedPath || filePath} err=${safeString(error?.message || error)}`,
      );
      try {
        fs.mkdirSync(failedDir, { recursive: true });
        const failedPath = path.join(
          failedDir,
          path.basename(claimedPath || filePath),
        );
        fs.renameSync(claimedPath || filePath, failedPath);
      } catch {}
    }
  }
}
