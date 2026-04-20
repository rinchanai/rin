import { safeString } from "../text-utils.js";

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatLocalDateOnly(date = new Date()) {
  const year = `${date.getFullYear()}`;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeCanonicalDateOnly(value: string) {
  const match = value.match(DATE_ONLY_RE);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "";
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeLeadingDateOnly(value: string) {
  const text = safeString(value).trim();
  if (!text) return "";
  const head = text.slice(0, 10);
  const normalized = normalizeCanonicalDateOnly(head);
  if (!normalized) return "";
  const suffix = text.slice(10);
  if (!suffix) return normalized;
  return /^[Tt]\d/.test(suffix) || /^\s+\d/.test(suffix)
    ? normalized
    : "";
}

function dateInputToLocalDateOnly(value: unknown) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : formatLocalDateOnly(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatLocalDateOnly(new Date(value));
  }
  return "";
}

export function normalizeLocalDateOnly(
  value: unknown,
  fallbackDate?: Date | null,
) {
  const normalizedText = normalizeLeadingDateOnly(safeString(value));
  if (normalizedText) return normalizedText;
  const normalizedDate = dateInputToLocalDateOnly(value);
  if (normalizedDate) return normalizedDate;
  return fallbackDate ? formatLocalDateOnly(fallbackDate) : "";
}
