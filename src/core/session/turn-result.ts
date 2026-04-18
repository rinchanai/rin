import path from "node:path";

import {
  extractExistingFilePaths,
  extractImageParts,
  extractMessageText,
} from "../message-content.js";
import { safeString } from "../text-utils.js";

export type TurnResultMessage =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      data: string;
      mimeType: string;
    }
  | {
      type: "file";
      path: string;
      name?: string;
    };

export type TurnResult = {
  messages: TurnResultMessage[];
};

export function extractFinalTextFromTurnResult(
  result: TurnResult | null | undefined,
) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  for (const message of messages) {
    if (!message || message.type !== "text") continue;
    const text = safeString(message.text).trim();
    if (text) return text;
  }
  return "";
}

function findLastAssistantMessage(messages: any[]) {
  for (const message of [...messages].reverse()) {
    if (safeString(message?.role) !== "assistant") continue;
    return message;
  }
  return null;
}

export function buildTurnResultFromMessages(messages: any[]): TurnResult {
  const assistant = findLastAssistantMessage(
    Array.isArray(messages) ? messages : [],
  );
  if (!assistant) return { messages: [] };

  const text = extractMessageText(assistant.content, { trim: true });
  const images = extractImageParts(assistant.content);
  const files = extractExistingFilePaths(text);
  const result: TurnResultMessage[] = [];

  if (text) result.push({ type: "text", text });
  for (const image of images) {
    result.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  for (const filePath of files) {
    result.push({
      type: "file",
      path: filePath,
      name: path.basename(filePath),
    });
  }

  return { messages: result };
}
