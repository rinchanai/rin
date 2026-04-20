import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { extractMessageText } from "../message-content.js";

export { computeAvailableThinkingLevels } from "../model-thinking-levels.js";

export function extractText(value: any): string {
  return extractMessageText(value, { includeThinking: true });
}

export function getLastAssistantText(messages: AgentMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: any = messages[i];
    if (message?.role !== "assistant") continue;
    const text = extractText(message.content);
    if (text) return text;
  }
  return undefined;
}

export function calculateContextTokens(usage: any) {
  if (!usage || typeof usage !== "object") return 0;
  return (
    Number(usage.totalTokens || 0) ||
    Number(usage.input || 0) +
      Number(usage.output || 0) +
      Number(usage.cacheRead || 0) +
      Number(usage.cacheWrite || 0)
  );
}

function estimateTextTokens(text: string) {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function estimateMessageTokens(message: any) {
  return estimateTextTokens(extractText(message?.content));
}

export function estimateContextTokens(messages: AgentMessage[]) {
  let trailingTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: any = messages[i];
    const usage = message?.role === "assistant" ? message?.usage : undefined;
    const stopReason = String(message?.stopReason || "");
    if (usage && stopReason !== "aborted" && stopReason !== "error")
      return calculateContextTokens(usage) + trailingTokens;
    trailingTokens += estimateMessageTokens(message);
  }
  return trailingTokens;
}
