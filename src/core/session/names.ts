import fs from "node:fs";
import path from "node:path";

import { normalizeSessionValue } from "./ref.js";
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

function emptySessionDisplayNameParts(): SessionDisplayNameParts {
  return { currentName: "", firstUserMessage: "" };
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
      .filter(
        (part) => part && typeof part === "object" && part.type === "text",
      )
      .map((part) => safeString((part as any).text))
      .join(" "),
    DEFAULT_FIRST_USER_MESSAGE_MAX,
  );
}

function parseSessionEntryLine(lineBuffer: Buffer<ArrayBufferLike>): any {
  const trimmed = lineBuffer.toString("utf8").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as any;
  } catch {
    return null;
  }
}

function copyBufferSlice(
  buffer: Buffer<ArrayBufferLike>,
  start: number,
  end = buffer.length,
): Buffer<ArrayBufferLike> {
  return start < end ? Buffer.from(buffer.subarray(start, end)) : EMPTY_BUFFER;
}

function combineSessionLineBuffers(
  left: Buffer<ArrayBufferLike>,
  right: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> {
  if (!left.length) return right;
  if (!right.length) return left;
  return Buffer.concat([left, right]);
}

function collectSessionDisplayNameParts(
  lineBuffer: Buffer<ArrayBufferLike>,
  parts: SessionDisplayNameParts,
): void {
  const entry = parseSessionEntryLine(lineBuffer);
  if (!entry) return;

  if (!parts.firstUserMessage) {
    const firstUserMessage = extractFirstUserMessage(entry);
    if (firstUserMessage) {
      parts.firstUserMessage = firstUserMessage;
    }
  }

  if (entry?.type !== "session_info") return;
  const currentName = normalizeSessionNameDetail(
    entry?.name,
    DEFAULT_SESSION_NAME_DETAIL_MAX,
  );
  if (currentName) {
    parts.currentName = currentName;
  }
}

function readSessionChunk(
  fd: number,
  buffer: Buffer<ArrayBufferLike>,
  position: number,
): { chunk: Buffer<ArrayBufferLike>; position: number } {
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
  return {
    chunk: bytesRead ? buffer.subarray(0, bytesRead) : EMPTY_BUFFER,
    position: position + bytesRead,
  };
}

function readSessionDisplayNamePartsFromFile(
  filePath: string,
): SessionDisplayNameParts {
  const fd = fs.openSync(filePath, "r");
  const buffer: Buffer<ArrayBufferLike> = Buffer.alloc(
    SESSION_NAME_READ_CHUNK_SIZE,
  );
  const parts = emptySessionDisplayNameParts();
  let remainder = EMPTY_BUFFER;

  try {
    let position = 0;
    while (true) {
      const nextChunk = readSessionChunk(fd, buffer, position);
      if (!nextChunk.chunk.length) {
        if (remainder.length) {
          collectSessionDisplayNameParts(remainder, parts);
        }
        return parts;
      }
      position = nextChunk.position;
      const chunk = combineSessionLineBuffers(remainder, nextChunk.chunk);
      let lineStart = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        collectSessionDisplayNameParts(chunk.subarray(lineStart, index), parts);
        lineStart = index + 1;
      }
      remainder = copyBufferSlice(chunk, lineStart);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function readSessionDisplayNameParts(
  sessionFile: string,
): SessionDisplayNameParts {
  const normalizedSessionFile = normalizeSessionValue(sessionFile);
  if (!normalizedSessionFile) return emptySessionDisplayNameParts();
  const filePath = path.resolve(normalizedSessionFile);

  try {
    return readSessionDisplayNamePartsFromFile(filePath);
  } catch {
    return emptySessionDisplayNameParts();
  }
}

export function readFirstUserMessageFromSessionFile(
  sessionFile: string,
): string {
  return readSessionDisplayNameParts(sessionFile).firstUserMessage;
}
