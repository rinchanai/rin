import fs from "node:fs";
import path from "node:path";

import { safeString } from "./text-utils.js";

export function extractMessageText(
  content: any,
  {
    includeThinking = false,
    trim = false,
  }: { includeThinking?: boolean; trim?: boolean } = {},
) {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => {
              if (!part || typeof part !== "object") return "";
              if (part.type === "text") return safeString(part.text);
              if (includeThinking && part.type === "thinking") {
                return safeString(part.thinking);
              }
              return "";
            })
            .filter(Boolean)
            .join("")
        : "";
  return trim ? text.trim() : text;
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
