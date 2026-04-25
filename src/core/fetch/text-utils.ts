import {
  applyRegexReplacements,
  type RegexReplacement,
} from "./regex-utils.js";

const HTML_ENTITY_REPLACEMENTS: RegexReplacement[] = [
  [/&nbsp;/gi, " "],
  [/&amp;/gi, "&"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#39;|&apos;/gi, "'"],
];

const SUPPORTED_TEXT_DECODER_ENCODINGS = new Set([
  "utf-8",
  "utf-16le",
  "utf-16be",
  "latin1",
  "iso-8859-1",
  "windows-1252",
]);

function pickEncoding(charset?: string) {
  const normalized = String(charset || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "utf-8";
  if (normalized === "utf8") return "utf-8";
  if (SUPPORTED_TEXT_DECODER_ENCODINGS.has(normalized)) return normalized;
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

function decodeHtmlCodePoint(match: string, value: number) {
  return Number.isFinite(value) ? String.fromCodePoint(value) : match;
}

export function decodeHtmlEntities(text: string) {
  return applyRegexReplacements(text, HTML_ENTITY_REPLACEMENTS)
    .replace(/&#(\d+);/g, (match, code) =>
      decodeHtmlCodePoint(match, Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (match, code) =>
      decodeHtmlCodePoint(match, Number.parseInt(code, 16)),
    );
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
