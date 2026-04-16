function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
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

export function normalizeSessionSummaryForName(
  summary: string,
  max = 180,
): string {
  const text = safeString(summary)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
