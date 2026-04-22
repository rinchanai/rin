import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeString } from "./text-utils.js";

export type RenderMessageTextOptions = {
  includeThinking?: boolean;
  renderAt?: (attrs: Record<string, any>) => string;
  normalizeChildren?: (text: string) => string;
};

const EMPTY_OBJECT: Record<string, any> = {};
const FILE_URL_PATTERN = /file:\/\/[^\s'"`<>]+/g;

function isMessagePart(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMessagePartType(value: unknown) {
  return safeString(value).trim().toLowerCase();
}

function getMessagePartType(content: any) {
  return normalizeMessagePartType(content?.type);
}

function getMessagePartAttrs(content: any) {
  return isMessagePart(content?.attrs) ? content.attrs : EMPTY_OBJECT;
}

function getMessagePartChildren(content: any) {
  return Array.isArray(content?.children) ? content.children : [];
}

function normalizeRenderedChildren(
  text: string,
  normalizeChildren?: (text: string) => string,
) {
  return typeof normalizeChildren === "function"
    ? normalizeChildren(text)
    : text;
}

function renderMessageChildren(
  content: any[],
  options: RenderMessageTextOptions,
) {
  return content.map((part) => renderMessageNode(part, options)).join("");
}

function renderMessageNode(
  content: any,
  options: RenderMessageTextOptions,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return renderMessageChildren(content, options);
  if (!isMessagePart(content)) return "";

  const type = getMessagePartType(content);
  const attrs = getMessagePartAttrs(content);
  switch (type) {
    case "text":
      return safeString(content.text ?? attrs.content ?? "");
    case "thinking":
      return options.includeThinking ? safeString(content.thinking) : "";
    case "at":
      return typeof options.renderAt === "function"
        ? safeString(options.renderAt(attrs))
        : "";
    case "br":
      return "\n";
    default: {
      const childText = renderMessageChildren(
        getMessagePartChildren(content),
        options,
      );
      const normalizedChildText = normalizeRenderedChildren(
        childText,
        options.normalizeChildren,
      );
      return type === "p" || type === "paragraph"
        ? normalizedChildText
          ? `${normalizedChildText}\n`
          : ""
        : normalizedChildText;
    }
  }
}

export function renderMessageText(
  content: any,
  options: RenderMessageTextOptions = {},
): string {
  return renderMessageNode(content, options);
}

export function extractMessageText(
  content: any,
  {
    includeThinking = false,
    trim = false,
  }: { includeThinking?: boolean; trim?: boolean } = {},
) {
  const text = renderMessageText(content, { includeThinking });
  return trim ? text.trim() : text;
}

export function normalizeMessageText(text: unknown) {
  return safeString(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMessagePartsByType(content: any, type: string) {
  const normalizedType = normalizeMessagePartType(type);
  if (!Array.isArray(content) || !normalizedType) {
    return [] as Array<Record<string, any>>;
  }
  return content.filter(
    (part): part is Record<string, any> =>
      isMessagePart(part) && getMessagePartType(part) === normalizedType,
  );
}

function collectUniqueTrimmedStrings<T>(
  values: T[],
  pick: (value: T) => unknown,
) {
  return Array.from(
    new Set(values.map((value) => safeString(pick(value)).trim()).filter(Boolean)),
  );
}

export function extractToolCallParts(content: any) {
  return extractMessagePartsByType(content, "toolCall");
}

export function extractToolCallNames(content: any) {
  return collectUniqueTrimmedStrings(
    extractToolCallParts(content),
    (part) => part.name || part.toolName || "",
  );
}

export function countToolCalls(content: any) {
  return extractToolCallParts(content).length;
}

export function extractImageParts(content: any) {
  return extractMessagePartsByType(content, "image")
    .map((part) => {
      const data = safeString(part.data || "");
      if (!data) return null;
      return {
        data,
        mimeType: safeString(part.mimeType || "").trim() || "image/png",
      };
    })
    .filter((part): part is { data: string; mimeType: string } => Boolean(part));
}

function normalizeFileUrlPath(rawUrl: string) {
  const value = safeString(rawUrl).trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "file:") return "";
    parsed.search = "";
    parsed.hash = "";
    return path.resolve(fileURLToPath(parsed));
  } catch {
    return "";
  }
}

function isExistingFile(filePath: string) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function extractExistingFilePaths(text: string, max = 8) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of safeString(text).matchAll(FILE_URL_PATTERN)) {
    const resolved = normalizeFileUrlPath(match[0]);
    if (!resolved || seen.has(resolved) || !isExistingFile(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out.slice(0, Math.max(0, max));
}
