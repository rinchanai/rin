import os from "node:os";
import path from "node:path";

import {
  latinTokens,
  normalizeNeedle,
  safeString,
  trimText,
  uniqueStrings,
} from "../../text-utils.js";

export { latinTokens, normalizeNeedle, safeString, trimText, uniqueStrings };

export function nowIso(): string {
  return new Date().toISOString();
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
