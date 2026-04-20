import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeString } from "./text-utils.js";

export type RenderMessageTextOptions = {
  includeThinking?: boolean;
  renderAt?: (attrs: Record<string, any>) => string;
  normalizeChildren?: (text: string) => string;
};

function getMessagePartType(content: any) {
  return safeString(content?.type).trim().toLowerCase();
}

function getMessagePartAttrs(content: any) {
  return content?.attrs && typeof content.attrs === "object" ? content.attrs : {};
}

export function renderMessageText(
  content: any,
  {
    includeThinking = false,
    renderAt,
    normalizeChildren,
  }: RenderMessageTextOptions = {},
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        renderMessageText(part, {
          includeThinking,
          renderAt,
          normalizeChildren,
        }),
      )
      .join("");
  }
  if (typeof content !== "object") return "";

  const type = getMessagePartType(content);
  const attrs = getMessagePartAttrs(content);
  if (type === "text") {
    return safeString(content.text ?? attrs.content ?? "");
  }
  if (includeThinking && type === "thinking") {
    return safeString(content.thinking);
  }
  if (type === "at") {
    return typeof renderAt === "function" ? safeString(renderAt(attrs)) : "";
  }
  if (type === "br") return "\n";

  const childText = renderMessageText(
    Array.isArray(content?.children) ? content.children : [],
    { includeThinking, renderAt, normalizeChildren },
  );
  const normalizedChildText =
    typeof normalizeChildren === "function"
      ? normalizeChildren(childText)
      : childText;
  if (type === "p" || type === "paragraph") {
    return normalizedChildText ? `${normalizedChildText}\n` : "";
  }
  return normalizedChildText;
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

function extractMessageObjectParts(content: any, type: string) {
  const normalizedType = safeString(type).trim().toLowerCase();
  if (!Array.isArray(content) || !normalizedType) {
    return [] as Array<Record<string, any>>;
  }
  return content.filter(
    (part): part is Record<string, any> =>
      Boolean(part) &&
      typeof part === "object" &&
      getMessagePartType(part) === normalizedType,
  );
}

export function extractToolCallParts(content: any) {
  return extractMessageObjectParts(content, "toolCall");
}

export function extractToolCallNames(content: any) {
  return Array.from(
    new Set(
      extractToolCallParts(content)
        .map((part) => safeString(part.name || part.toolName || "").trim())
        .filter(Boolean),
    ),
  );
}

export function countToolCalls(content: any) {
  return extractToolCallParts(content).length;
}

export function extractImageParts(content: any) {
  const out: Array<{ data: string; mimeType: string }> = [];
  for (const part of extractMessageObjectParts(content, "image")) {
    const data = safeString(part.data || "");
    if (!data) continue;
    out.push({
      data,
      mimeType: safeString(part.mimeType || "").trim() || "image/png",
    });
  }
  return out;
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

export function extractExistingFilePaths(text: string, max = 8) {
  const out: string[] = [];
  const seen = new Set<string>();
  const pattern = /file:\/\/[^\s'"`<>]+/g;
  for (const match of safeString(text).matchAll(pattern)) {
    const resolved = normalizeFileUrlPath(match[0]);
    if (!resolved || seen.has(resolved)) continue;
    if (!fs.existsSync(resolved)) continue;
    if (!fs.statSync(resolved).isFile()) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out.slice(0, Math.max(0, max));
}
