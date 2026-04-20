type RegexReplacement = readonly [RegExp, string];

const HTML_ENTITY_REPLACEMENTS: RegexReplacement[] = [
  [/&nbsp;/gi, " "],
  [/&amp;/gi, "&"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#39;|&apos;/gi, "'"],
];

function applyRegexReplacements(
  text: string,
  replacements: readonly RegexReplacement[],
) {
  return replacements.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    String(text || ""),
  );
}

function pickEncoding(charset?: string) {
  const normalized = String(charset || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "utf-8";
  if (normalized === "utf8") return "utf-8";
  if (
    [
      "utf-8",
      "utf-16le",
      "utf-16be",
      "latin1",
      "iso-8859-1",
      "windows-1252",
    ].includes(normalized)
  ) {
    return normalized;
  }
  return "utf-8";
}

export function decodeBuffer(buffer: Buffer, charset?: string) {
  const encoding = pickEncoding(charset);
  try {
    return new TextDecoder(encoding as any, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

export function decodeHtmlEntities(text: string) {
  return applyRegexReplacements(text, HTML_ENTITY_REPLACEMENTS)
    .replace(/&#(\d+);/g, (_match, code) => {
      const value = Number(code);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _match;
    });
}

export function normalizeRawText(text: string) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\0")
    .join("");
}

export function normalizePlainText(text: string) {
  return normalizeRawText(text)
    .replace(/\t/g, "  ")
    .replace(/[ \f\v]+\n/g, "\n")
    .replace(/\n[ \f\v]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function maybePrettyJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
