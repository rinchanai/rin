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

export type TurnCompletionInput = {
  result?: TurnResult | null;
  messages?: any[];
  finalText?: unknown;
};

function buildTextOnlyTurnResult(text: unknown): TurnResult {
  const value = safeString(text).trim();
  return value
    ? { messages: [{ type: "text", text: value }] }
    : { messages: [] };
}

function normalizeTurnResult(
  result: TurnResult | null | undefined,
): TurnResult | null {
  if (!Array.isArray(result?.messages)) return null;
  return { messages: result.messages.filter(Boolean) };
}

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

export function resolveTurnResult(input: TurnCompletionInput = {}): TurnResult {
  const existingResult = normalizeTurnResult(input.result);
  if (existingResult && extractFinalTextFromTurnResult(existingResult)) {
    return existingResult;
  }

  const messagesResult = Array.isArray(input.messages)
    ? buildTurnResultFromMessages(input.messages)
    : null;
  if (messagesResult && extractFinalTextFromTurnResult(messagesResult)) {
    return messagesResult;
  }

  const fallbackText = safeString(input.finalText).trim();
  if (existingResult) {
    return fallbackText
      ? {
          messages: [
            { type: "text", text: fallbackText },
            ...existingResult.messages,
          ],
        }
      : existingResult;
  }
  if (messagesResult) return messagesResult;
  return buildTextOnlyTurnResult(fallbackText);
}

export function resolveTurnCompletion(input: TurnCompletionInput = {}) {
  const result = resolveTurnResult(input);
  return {
    result,
    finalText: extractFinalTextFromTurnResult(result),
  };
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
