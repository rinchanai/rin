export function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
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

export function normalizeNeedle(value: string): string {
  return safeString(value).toLowerCase().replace(/\s+/g, " ").trim();
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
