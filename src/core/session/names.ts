import fs from "node:fs";
import path from "node:path";

function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

const DEFAULT_SESSION_NAME_DETAIL_MAX = 180;

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

export function readFirstUserMessageFromSessionFile(sessionFile: string): string {
  const filePath = path.resolve(safeString(sessionFile).trim());
  if (!filePath || !fs.existsSync(filePath)) return "";
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = JSON.parse(trimmed) as any;
      if (entry?.type !== "message") continue;
      const message = entry?.message;
      if (safeString(message?.role).trim() !== "user") continue;
      const content = message?.content;
      if (typeof content === "string") {
        const text = normalizeSessionNameDetail(content, 120);
        if (text) return text;
        continue;
      }
      if (!Array.isArray(content)) continue;
      const text = normalizeSessionNameDetail(
        content
          .filter((part) => part && typeof part === "object" && part.type === "text")
          .map((part) => safeString((part as any).text))
          .join(" "),
        120,
      );
      if (text) return text;
    }
  } catch {}
  return "";
}

