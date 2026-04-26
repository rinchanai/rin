import { safeString } from "../text-utils.js";

const DEFAULT_SESSION_SUMMARY_MAX_LENGTH = 180;

function normalizeSessionSummaryMaxLength(max: unknown) {
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
    return DEFAULT_SESSION_SUMMARY_MAX_LENGTH;
  }
  return Math.trunc(max);
}

export function buildSessionRecallSummaryPrompt(sessionPath: string): string {
  const normalizedSessionPath = safeString(sessionPath).trim() || "(unknown)";
  return [
    "Read the session file and summarize the session in no more than three short sentences.",
    `The session file path is: ${normalizedSessionPath}`,
    "Focus on what was accomplished, key decisions, and notable remaining context.",
    "Do not include the path in the final answer.",
    "Do not output anything other than that summary.",
  ].join("\n\n");
}

export function normalizeSessionSummaryText(
  summary: string,
  max = DEFAULT_SESSION_SUMMARY_MAX_LENGTH,
): string {
  const maxLength = normalizeSessionSummaryMaxLength(max);
  const text = safeString(summary).replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  if (maxLength === 1) return "…";
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
