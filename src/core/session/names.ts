import fs from "node:fs";
import path from "node:path";

import { normalizeSessionValue } from "./ref.js";
import {
  extractMessageText,
  normalizeMessageText,
} from "../message-content.js";
import { safeString } from "../text-utils.js";

export const DEFAULT_SESSION_NAME_DETAIL_MAX = 180;
export const DEFAULT_FIRST_USER_MESSAGE_MAX = 120;
export const DEFAULT_SESSION_DISPLAY_NAME = "Untitled session";

const SESSION_NAME_READ_CHUNK_SIZE = 64 * 1024;
const EMPTY_BUFFER: Buffer<ArrayBufferLike> = Buffer.alloc(0);

export type SessionDisplayNameParts = {
  currentName: string;
  firstUserMessage: string;
};

function createEmptySessionDisplayNameParts(): SessionDisplayNameParts {
  return {
    currentName: "",
    firstUserMessage: "",
  };
}

export function normalizeSessionNameDetail(
  value: unknown,
  max = DEFAULT_SESSION_NAME_DETAIL_MAX,
): string {
  const text = safeString(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function resolveSessionDisplayName(
  parts: Partial<SessionDisplayNameParts> | null | undefined,
  fallback: unknown = "",
): string {
  return (
    normalizeSessionNameDetail(
      parts?.currentName,
      DEFAULT_SESSION_NAME_DETAIL_MAX,
    ) ||
    normalizeSessionNameDetail(
      parts?.firstUserMessage,
      DEFAULT_FIRST_USER_MESSAGE_MAX,
    ) ||
    normalizeSessionNameDetail(fallback, DEFAULT_SESSION_NAME_DETAIL_MAX)
  );
}

function normalizeFirstUserMessageContent(content: unknown): string {
  return normalizeSessionNameDetail(
    normalizeMessageText(extractMessageText(content)),
    DEFAULT_FIRST_USER_MESSAGE_MAX,
  );
}

function extractFirstUserMessage(entry: any): string {
  if (entry?.type !== "message") return "";
  const message = entry?.message;
  if (safeString(message?.role).trim() !== "user") return "";
  return normalizeFirstUserMessageContent(message?.content);
}

function applySessionEntryLine(
  parts: SessionDisplayNameParts,
  lineBuffer: Buffer<ArrayBufferLike>,
): void {
  const trimmed = lineBuffer.toString("utf8").trim();
  if (!trimmed) return;

  let entry: any;
  try {
    entry = JSON.parse(trimmed) as any;
  } catch {
    return;
  }

  if (!parts.firstUserMessage) {
    const firstUserMessage = extractFirstUserMessage(entry);
    if (firstUserMessage) parts.firstUserMessage = firstUserMessage;
  }

  if (entry?.type !== "session_info") return;
  const currentName = normalizeSessionNameDetail(
    entry?.name,
    DEFAULT_SESSION_NAME_DETAIL_MAX,
  );
  if (currentName) parts.currentName = currentName;
}

function readSessionDisplayNamePartsFromFile(
  filePath: string,
): SessionDisplayNameParts {
  const fd = fs.openSync(filePath, "r");
  const buffer: Buffer<ArrayBufferLike> = Buffer.alloc(
    SESSION_NAME_READ_CHUNK_SIZE,
  );
  const parts = createEmptySessionDisplayNameParts();
  let remainder = EMPTY_BUFFER;

  try {
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const nextChunk = buffer.subarray(0, bytesRead);
      const chunk = remainder.length
        ? Buffer.concat([remainder, nextChunk])
        : nextChunk;
      let lineStart = 0;
      while (lineStart < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, lineStart);
        if (newlineIndex === -1) break;
        applySessionEntryLine(parts, chunk.subarray(lineStart, newlineIndex));
        lineStart = newlineIndex + 1;
      }
      remainder =
        lineStart < chunk.length
          ? Buffer.from(chunk.subarray(lineStart))
          : EMPTY_BUFFER;
    }
    if (remainder.length) {
      applySessionEntryLine(parts, remainder);
    }
    return parts;
  } finally {
    fs.closeSync(fd);
  }
}

export function readSessionDisplayNameParts(
  sessionFile: string,
): SessionDisplayNameParts {
  const normalizedSessionFile = normalizeSessionValue(sessionFile);
  if (!normalizedSessionFile) return createEmptySessionDisplayNameParts();
  const filePath = path.resolve(normalizedSessionFile);

  try {
    return readSessionDisplayNamePartsFromFile(filePath);
  } catch {
    return createEmptySessionDisplayNameParts();
  }
}

export function readFirstUserMessageFromSessionFile(
  sessionFile: string,
): string {
  return readSessionDisplayNameParts(sessionFile).firstUserMessage;
}
