function iterValues(values: Iterable<unknown> | null | undefined) {
  return values ?? [];
}

export function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function normalizeTrimmedString(value: unknown): string {
  return safeString(value).trim();
}

function normalizeWhitespace(value: unknown): string {
  return safeString(value).replace(/\s+/g, " ").trim();
}

function normalizeStringEntry(value: unknown) {
  const text = normalizeTrimmedString(value);
  const key = text.toLowerCase();
  return key ? { text, key } : null;
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
    const entry = normalizeStringEntry(value);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push(options.lowercase ? entry.key : entry.text);
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
  return normalizeStringList(
    safeString(value)
      .toLowerCase()
      .match(/[a-z0-9]+(?:[_/-][a-z0-9]+)*/g)
      ?.filter((item) => item.length >= 3),
    { lowercase: true },
  );
}
