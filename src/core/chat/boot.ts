import fs from "node:fs";
import path from "node:path";

import { chatOutboxDir } from "../rin-lib/chat-outbox.js";
import { listJsonFiles, safeString } from "./chat-helpers.js";
import { readJsonFile } from "./support.js";
import { sendOutboxPayload } from "./transport.js";

export type ChatCommandRow = {
  name: string;
  description?: string;
};

const KOISHI_CHAT_COMMAND_ROWS: readonly ChatCommandRow[] = [
  { name: "help", description: "Show available commands" },
  { name: "abort", description: "Abort current operation" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact the current session" },
  {
    name: "reload",
    description: "Reload extensions, prompts, skills, and themes",
  },
  { name: "status", description: "Show current chat processing status" },
  { name: "session", description: "Show current session status" },
  { name: "resume", description: "Resume a previous session" },
  { name: "model", description: "Show or change the current model" },
];

export function getChatCommandRows(): ChatCommandRow[] {
  return KOISHI_CHAT_COMMAND_ROWS.map((item) => ({ ...item }));
}

export function buildTelegramCommandPayload(commandRows: ChatCommandRow[]) {
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
  commandRows: ChatCommandRow[] = [],
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
        `chat command sync failed platform=${safeString(bot?.platform)} selfId=${safeString(bot?.selfId)} err=${safeString(error?.message || error)}`,
      );
    }
  }
}

export async function drainChatOutbox(
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
        `chat outbox failed file=${claimedPath || filePath} err=${safeString(error?.message || error)}`,
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
