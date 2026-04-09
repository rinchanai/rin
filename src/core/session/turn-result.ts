import fs from "node:fs";
import path from "node:path";

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

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function extractText(content: any) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return safeString((part as any).text);
      return "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

function extractImages(content: any) {
  if (!Array.isArray(content))
    return [] as Array<{ data: string; mimeType: string }>;
  const out: Array<{ data: string; mimeType: string }> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type !== "image") continue;
    const data = safeString((part as any).data || "");
    if (!data) continue;
    out.push({
      data,
      mimeType: safeString((part as any).mimeType || "").trim() || "image/png",
    });
  }
  return out;
}

function extractExistingFilePaths(text: string) {
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
  return out.slice(0, 8);
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

  const text = extractText(assistant.content);
  const images = extractImages(assistant.content);
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
