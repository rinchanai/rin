import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function trimText(value: unknown, max = 280): string {
  const text = safeString(value).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = safeString(value).trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function normalizeList(value: unknown): string[] {
  if (Array.isArray(value))
    return uniqueStrings(
      value.map((item) => safeString(item).trim()).filter(Boolean),
    );
  return uniqueStrings(
    safeString(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function slugify(input: string, fallback = "memory"): string {
  const base = safeString(input).trim().toLowerCase();
  const slug = base
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

export function sha(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function normalizeNeedle(value: string): string {
  return safeString(value).toLowerCase().replace(/\s+/g, " ").trim();
}

export function cjkBigrams(value: string): string[] {
  const raw = safeString(value).replace(/\s+/g, "");
  const chars = [...raw].filter((char) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char),
  );
  const out: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1)
    out.push(`${chars[index]}${chars[index + 1]}`);
  return uniqueStrings(out);
}

export function latinTokens(value: string): string[] {
  return uniqueStrings(
    safeString(value)
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/g)
      .map((item) => item.trim())
      .filter((item) => item.length >= 3),
  );
}

export function conceptTokens(value: string): string[] {
  return uniqueStrings([...latinTokens(value), ...cjkBigrams(value)]);
}

export function resolveAgentDir(): string {
  const fromEnv = safeString(
    process.env.PI_CODING_AGENT_DIR || process.env.RIN_DIR,
  ).trim();
  if (fromEnv) return path.resolve(fromEnv);
  const fallback = process.env.HOME ? path.join(process.env.HOME, ".rin") : path.join(os.homedir(), ".rin");
  return path.resolve(fallback);
}
