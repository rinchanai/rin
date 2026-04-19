import fs from "node:fs";
import path from "node:path";
import {
  normalizeSessionValue,
} from "./metadata.js";
import { safeString } from "../text-utils.js";

const DEFAULT_SESSION_NAME_DETAIL_MAX = 180;
const DEFAULT_FIRST_USER_MESSAGE_MAX = 120;

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

export function readSessionDisplayNameParts(
  sessionFile: string,
): SessionDisplayNameParts {
  const normalizedSessionFile = normalizeSessionValue(sessionFile);
  const filePath = normalizedSessionFile ? path.resolve(normalizedSessionFile) : "";
  if (!filePath || !fs.existsSync(filePath)) {
    return { currentName: "", firstUserMessage: "" };
  }

  let currentName = "";
  let firstUserMessage = "";
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = JSON.parse(trimmed) as any;
      if (entry?.type === "session_info") {
        currentName = normalizeSessionNameDetail(entry?.name || "", 180);
        continue;
      }
      if (!firstUserMessage) {
        firstUserMessage = extractFirstUserMessage(entry);
      }
    }
  } catch {
    return { currentName: "", firstUserMessage: "" };
  }

  return { currentName, firstUserMessage };
}

export function readFirstUserMessageFromSessionFile(sessionFile: string): string {
  return readSessionDisplayNameParts(sessionFile).firstUserMessage;
}

