function normalizeWhitespace(value: unknown): string {
  return safeString(value).replace(/\s+/g, " ").trim();
}

function normalizeStringKey(value: unknown): string {
  return safeString(value).trim().toLowerCase();
}

function iterValues(values: Iterable<unknown> | null | undefined) {
  return values ?? [];
}

export function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

export function trimText(value: unknown, max = 280): string {
  const text = normalizeWhitespace(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export type NormalizeStringListOptions = {
  lowercase?: boolean;
};

export function normalizeStringList(
  values: Iterable<unknown> | null | undefined,
  options: NormalizeStringListOptions = {},
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of iterValues(values)) {
    const normalized = safeString(value).trim();
    const key = normalizeStringKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(options.lowercase ? key : normalized);
  }
  return out;
}

export function uniqueStrings(values: string[]): string[] {
  return normalizeStringList(values);
}

export function normalizeNeedle(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

export function latinTokens(value: string): string[] {
  return uniqueStrings(
    safeString(value)
      .toLowerCase()
      .match(/[a-z0-9]+(?:[_/-][a-z0-9]+)*/g)
      ?.filter((item) => item.length >= 3) ?? [],
  );
}
