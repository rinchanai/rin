import { safeString } from "../text-utils.js";

export function formatLocalDateOnly(date = new Date()) {
  const year = `${date.getFullYear()}`;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeLocalDateOnly(
  value: unknown,
  fallbackDate?: Date | null,
) {
  const text = safeString(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const date = text ? new Date(text) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return fallbackDate ? formatLocalDateOnly(fallbackDate) : "";
  }
  return formatLocalDateOnly(date);
}
