import fs from "node:fs";
import path from "node:path";

import { safeString } from "./text-utils.js";

function collectMessagePartText(
  content: any,
  { includeThinking = false }: { includeThinking?: boolean } = {},
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => collectMessagePartText(part, { includeThinking }))
      .join("");
  }
  if (typeof content !== "object") return "";

  const type = safeString(content?.type).toLowerCase();
  const attrs =
    content?.attrs && typeof content.attrs === "object" ? content.attrs : {};
  if (type === "text") {
    return safeString(content.text ?? attrs.content ?? "");
  }
  if (includeThinking && type === "thinking") {
    return safeString(content.thinking);
  }
  if (type === "br") return "\n";

  const children = Array.isArray(content?.children) ? content.children : [];
  const childText = children
    .map((part) => collectMessagePartText(part, { includeThinking }))
    .join("");
  if (type === "p" || type === "paragraph") {
    return childText ? `${childText}\n` : "";
  }
  return childText;
}

export function extractMessageText(
  content: any,
  {
    includeThinking = false,
    trim = false,
  }: { includeThinking?: boolean; trim?: boolean } = {},
) {
  const text = collectMessagePartText(content, { includeThinking });
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
  if (!Array.isArray(content)) return [] as Array<Record<string, any>>;
  return content.filter(
    (part): part is Record<string, any> =>
      Boolean(part) && typeof part === "object" && part.type === type,
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

export function extractExistingFilePaths(text: string, max = 8) {
  const out: string[] = [];
  const seen = new Set<string>();
  const pattern = /file:\/\/(\/[^\s'"`<>]+)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = safeString(match[1] || "").trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (seen.has(resolved)) continue;
    if (!fs.existsSync(resolved)) continue;
    if (!fs.statSync(resolved).isFile()) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out.slice(0, Math.max(0, max));
}
