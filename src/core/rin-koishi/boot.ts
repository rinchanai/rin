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

export async function syncTelegramCommands(app: any, logger: any) {
  const commander = app.$commander;
  if (!commander?.updateCommands) return;
  for (const bot of Array.isArray(app.bots) ? app.bots : []) {
    if (safeString(bot?.platform) !== "telegram") continue;
    if (typeof bot?.updateCommands !== "function") continue;
    try {
      await commander.updateCommands(bot);
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
