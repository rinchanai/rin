import fs from "node:fs";
import path from "node:path";

import { normalizeSessionValue } from "./ref.js";
import { safeString } from "../text-utils.js";

export const DEFAULT_SESSION_NAME_DETAIL_MAX = 180;
export const DEFAULT_FIRST_USER_MESSAGE_MAX = 120;
export const DEFAULT_SESSION_DISPLAY_NAME = "Untitled session";

const SESSION_NAME_READ_CHUNK_SIZE = 64 * 1024;

export type SessionDisplayNameParts = {
  currentName: string;
  firstUserMessage: string;
};

export function normalizeSessionNameDetail(
  value: unknown,
  max = DEFAULT_SESSION_NAME_DETAIL_MAX,
): string {
  const text = safeString(value)
    .replace(/\s+/g, " ")
    .trim();
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

function extractFirstUserMessage(entry: any): string {
  if (entry?.type !== "message") return "";
  const message = entry?.message;
  if (safeString(message?.role).trim() !== "user") return "";
  const content = message?.content;
  if (typeof content === "string") {
    return normalizeSessionNameDetail(content, DEFAULT_FIRST_USER_MESSAGE_MAX);
  }
  if (!Array.isArray(content)) return "";
  return normalizeSessionNameDetail(
    content
      .filter((part) => part && typeof part === "object" && part.type === "text")
      .map((part) => safeString((part as any).text))
      .join(" "),
    DEFAULT_FIRST_USER_MESSAGE_MAX,
  );
}

function parseSessionEntryLine(lineBuffer: Uint8Array): any {
  const trimmed = Buffer.from(lineBuffer).toString("utf8").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as any;
  } catch {
    return null;
  }
}

function readForwardSessionValue(
  filePath: string,
  selectValue: (entry: any) => string,
): string {
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(SESSION_NAME_READ_CHUNK_SIZE);
  let remainder = Buffer.alloc(0);

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      let lineStart = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const line = remainder.length
          ? Buffer.concat([remainder, chunk.subarray(lineStart, index)])
          : chunk.subarray(lineStart, index);
        remainder = Buffer.alloc(0);
        lineStart = index + 1;
        const entry = parseSessionEntryLine(line);
        const value = entry ? selectValue(entry) : "";
        if (value) return value;
      }
      const tail = chunk.subarray(lineStart);
      remainder = remainder.length ? Buffer.concat([remainder, tail]) : Buffer.from(tail);
    }
    const entry = parseSessionEntryLine(remainder);
    return entry ? selectValue(entry) : "";
  } finally {
    fs.closeSync(fd);
  }
}

function readBackwardSessionValue(
  filePath: string,
  selectValue: (entry: any) => string,
): string {
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(SESSION_NAME_READ_CHUNK_SIZE);
  let remainder = Buffer.alloc(0);

  try {
    let position = fs.fstatSync(fd).size;
    while (position > 0) {
      const readSize = Math.min(buffer.length, position);
      position -= readSize;
      fs.readSync(fd, buffer, 0, readSize, position);
      const chunk = Buffer.from(buffer.subarray(0, readSize));
      const combined = remainder.length ? Buffer.concat([chunk, remainder]) : chunk;
      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) continue;
        const entry = parseSessionEntryLine(combined.subarray(index + 1, lineEnd));
        const value = entry ? selectValue(entry) : "";
        if (value) return value;
        lineEnd = index;
      }
      remainder = Buffer.from(combined.subarray(0, lineEnd));
    }
    const entry = parseSessionEntryLine(remainder);
    return entry ? selectValue(entry) : "";
  } finally {
    fs.closeSync(fd);
  }
}

function readSessionNameFromFile(filePath: string): string {
  return readBackwardSessionValue(filePath, (entry) => {
    if (entry?.type !== "session_info") return "";
    return normalizeSessionNameDetail(entry?.name, DEFAULT_SESSION_NAME_DETAIL_MAX);
  });
}

function readFirstUserMessageFromFile(filePath: string): string {
  return readForwardSessionValue(filePath, extractFirstUserMessage);
}

export function readSessionDisplayNameParts(
  sessionFile: string,
): SessionDisplayNameParts {
  const normalizedSessionFile = normalizeSessionValue(sessionFile);
  const filePath = normalizedSessionFile ? path.resolve(normalizedSessionFile) : "";
  if (!filePath || !fs.existsSync(filePath)) {
    return { currentName: "", firstUserMessage: "" };
  }

  try {
    return {
      currentName: readSessionNameFromFile(filePath),
      firstUserMessage: readFirstUserMessageFromFile(filePath),
    };
  } catch {
    return { currentName: "", firstUserMessage: "" };
  }
}

export function readFirstUserMessageFromSessionFile(sessionFile: string): string {
  return readSessionDisplayNameParts(sessionFile).firstUserMessage;
}

