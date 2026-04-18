import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";

import { extractMessageText } from "../message-content.js";

const ALL_THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function extractText(value: any): string {
  return extractMessageText(value, { includeThinking: true });
}

export function computeAvailableThinkingLevels(model: any): ThinkingLevel[] {
  if (!model?.reasoning) return ["off"];
  const id = String(model?.id || "").toLowerCase();
  const provider = String(model?.provider || "").toLowerCase();
  return provider === "openai" && id.includes("codex-max")
    ? ALL_THINKING_LEVELS
    : ["off", "minimal", "low", "medium", "high"];
}

export function getLastAssistantText(messages: AgentMessage[]) {
  for (const message of [...messages].reverse()) {
    if ((message as any)?.role !== "assistant") continue;
    const text = extractText((message as any).content);
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

export function estimateMessageTokens(message: any) {
  const text = extractText(message?.content);
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateContextTokens(messages: AgentMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: any = messages[i];
    const usage = message?.role === "assistant" ? message?.usage : undefined;
    const stopReason = String(message?.stopReason || "");
    if (usage && stopReason !== "aborted" && stopReason !== "error") {
      let trailingTokens = 0;
      for (let j = i + 1; j < messages.length; j++)
        trailingTokens += estimateMessageTokens(messages[j]);
      return calculateContextTokens(usage) + trailingTokens;
    }
  }

  let estimated = 0;
  for (const message of messages) estimated += estimateMessageTokens(message);
  return estimated;
}
