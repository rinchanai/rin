export type AssistantTextPhase = "commentary" | "final_answer";

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function parseTextPhase(signature: unknown): AssistantTextPhase | undefined {
  if (typeof signature !== "string") return undefined;
  if (!signature.startsWith("{")) return undefined;
  try {
    const parsed = asRecord(JSON.parse(signature));
    const phase = parsed?.phase;
    return phase === "commentary" || phase === "final_answer" ? phase : undefined;
  } catch {
    return undefined;
  }
}

function collectText(
  content: unknown,
  predicate: (phase: AssistantTextPhase | undefined) => boolean,
) {
  if (typeof content === "string") return predicate(undefined) ? content.trim() : "";
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      if (!record || record.type !== "text") return "";
      const phase = parseTextPhase(record.textSignature);
      return predicate(phase) ? safeString(record.text) : "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

function hasPhasedText(content: unknown) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const record = asRecord(part);
    return record?.type === "text" && parseTextPhase(record.textSignature) != null;
  });
}

export function extractAssistantPlainText(content: unknown) {
  return collectText(content, () => true);
}

export function extractAssistantCommentaryText(content: unknown) {
  const commentaryText = collectText(content, (phase) => phase === "commentary");
  if (commentaryText) return commentaryText;
  return hasPhasedText(content) ? "" : extractAssistantPlainText(content);
}

export function extractAssistantFinalText(content: unknown) {
  const finalText = collectText(content, (phase) => phase === "final_answer");
  if (finalText) return finalText;
  if (hasPhasedText(content)) {
    return collectText(content, (phase) => phase == null);
  }
  return extractAssistantPlainText(content);
}
