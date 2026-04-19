import fs from "node:fs";
import path from "node:path";

import { normalizeSessionValue } from "./ref.js";
import { safeString } from "../text-utils.js";

export const DEFAULT_SESSION_NAME_DETAIL_MAX = 180;
export const DEFAULT_FIRST_USER_MESSAGE_MAX = 120;
export const DEFAULT_SESSION_DISPLAY_NAME = "Untitled session";

const SESSION_NAME_READ_CHUNK_SIZE = 64 * 1024;
const EMPTY_BUFFER = new Uint8Array(0);

type SessionLineReadDirection = "forward" | "backward";

export type SessionDisplayNameParts = {
  currentName: string;
  firstUserMessage: string;
};

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

function parseSessionEntryLine(lineBuffer: Uint8Array): any {
  const trimmed = Buffer.from(lineBuffer).toString("utf8").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as any;
  } catch {
    return null;
  }
}

function copyBufferSlice(
  buffer: Uint8Array,
  start: number,
  end = buffer.length,
): Uint8Array {
  return start < end ? Buffer.from(buffer.subarray(start, end)) : EMPTY_BUFFER;
}

function combineSessionLineBuffers(
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array {
  if (!left.length) return right;
  if (!right.length) return left;
  return Buffer.concat([Buffer.from(left), Buffer.from(right)]);
}

function selectSessionLineValue(
  lineBuffer: Uint8Array,
  selectValue: (entry: any) => string,
): string {
  const entry = parseSessionEntryLine(lineBuffer);
  return entry ? selectValue(entry) : "";
}

function scanSessionLineBuffer(
  buffer: Uint8Array,
  direction: SessionLineReadDirection,
  selectValue: (entry: any) => string,
): { remainder: Uint8Array; value: string } {
  if (direction === "forward") {
    let lineStart = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      const value = selectSessionLineValue(
        buffer.subarray(lineStart, index),
        selectValue,
      );
      if (value) return { remainder: EMPTY_BUFFER, value };
      lineStart = index + 1;
    }
    return { remainder: copyBufferSlice(buffer, lineStart), value: "" };
  }

  let lineEnd = buffer.length;
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    if (buffer[index] !== 0x0a) continue;
    const value = selectSessionLineValue(
      buffer.subarray(index + 1, lineEnd),
      selectValue,
    );
    if (value) return { remainder: EMPTY_BUFFER, value };
    lineEnd = index;
  }
  return { remainder: copyBufferSlice(buffer, 0, lineEnd), value: "" };
}

function readSessionValue(
  filePath: string,
  direction: SessionLineReadDirection,
  selectValue: (entry: any) => string,
): string {
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(SESSION_NAME_READ_CHUNK_SIZE);
  let remainder: Uint8Array<ArrayBufferLike> = EMPTY_BUFFER;

  try {
    if (direction === "forward") {
      while (true) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        const scan = scanSessionLineBuffer(
          combineSessionLineBuffers(remainder, buffer.subarray(0, bytesRead)),
          direction,
          selectValue,
        );
        if (scan.value) return scan.value;
        remainder = scan.remainder;
      }
      return selectSessionLineValue(remainder, selectValue);
    }

    let position = fs.fstatSync(fd).size;
    while (position > 0) {
      const readSize = Math.min(buffer.length, position);
      position -= readSize;
      fs.readSync(fd, buffer, 0, readSize, position);
      const scan = scanSessionLineBuffer(
        combineSessionLineBuffers(buffer.subarray(0, readSize), remainder),
        direction,
        selectValue,
      );
      if (scan.value) return scan.value;
      remainder = scan.remainder;
    }
    return selectSessionLineValue(remainder, selectValue);
  } finally {
    fs.closeSync(fd);
  }
}

function readSessionNameFromFile(filePath: string): string {
  return readSessionValue(filePath, "backward", (entry) => {
    if (entry?.type !== "session_info") return "";
    return normalizeSessionNameDetail(
      entry?.name,
      DEFAULT_SESSION_NAME_DETAIL_MAX,
    );
  });
}

function readFirstUserMessageFromFile(filePath: string): string {
  return readSessionValue(filePath, "forward", extractFirstUserMessage);
}

export function readSessionDisplayNameParts(
  sessionFile: string,
): SessionDisplayNameParts {
  const normalizedSessionFile = normalizeSessionValue(sessionFile);
  const filePath = normalizedSessionFile
    ? path.resolve(normalizedSessionFile)
    : "";
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

export function readFirstUserMessageFromSessionFile(
  sessionFile: string,
): string {
  return readSessionDisplayNameParts(sessionFile).firstUserMessage;
}
