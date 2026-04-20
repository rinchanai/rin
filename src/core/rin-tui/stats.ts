import { countToolCalls } from "../message-content.js";
import { readUsageMetrics } from "../usage-metrics.js";
import {
  calculateContextTokens,
  estimateContextTokens,
} from "./session-helpers.js";

export function getContextUsage(model: any, messages: any[], branch: any[]) {
  const contextWindow = Number(model?.contextWindow || 0);
  if (contextWindow <= 0) return undefined;

  let latestCompactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]?.type === "compaction") {
      latestCompactionIndex = i;
      break;
    }
  }

  if (latestCompactionIndex >= 0) {
    let hasPostCompactionUsage = false;
    for (let i = branch.length - 1; i > latestCompactionIndex; i--) {
      const entry = branch[i];
      const message: any = entry?.type === "message" ? entry.message : null;
      const usage = message?.role === "assistant" ? message?.usage : undefined;
      const stopReason = String(message?.stopReason || "");
      if (usage && stopReason !== "aborted" && stopReason !== "error") {
        if (calculateContextTokens(usage) > 0) hasPostCompactionUsage = true;
        break;
      }
    }
    if (!hasPostCompactionUsage) {
      return { tokens: null, contextWindow, percent: null };
    }
  }

  const tokens = estimateContextTokens(messages);
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

export function computeSessionStats(
  model: any,
  sessionFile: string | undefined,
  sessionId: string,
  entries: any[],
  contextUsage: any,
) {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;

  for (const entry of entries) {
    if (entry?.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user") userMessages += 1;
    if (message.role === "assistant") {
      assistantMessages += 1;
      const usageMetrics = readUsageMetrics((message as any).usage);
      input += usageMetrics.input;
      output += usageMetrics.output;
      cacheRead += usageMetrics.cacheRead;
      cacheWrite += usageMetrics.cacheWrite;
      cost += usageMetrics.costTotal;
      toolCalls += countToolCalls((message as any).content);
    }
    if (message.role === "toolResult") toolResults += 1;
  }

  const totalTokens = input + output + cacheRead + cacheWrite;
  return {
    sessionFile,
    sessionId,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: userMessages + assistantMessages + toolResults,
    tokens: { input, output, cacheRead, cacheWrite, total: totalTokens },
    cost,
    contextUsage,
  };
}

export function reconcilePendingQueues(
  steeringMessages: string[],
  followUpMessages: string[],
  targetCount: number,
) {
  let total = steeringMessages.length + followUpMessages.length;
  while (total > targetCount && steeringMessages.length > 0) {
    steeringMessages.shift();
    total -= 1;
  }
  while (total > targetCount && followUpMessages.length > 0) {
    followUpMessages.shift();
    total -= 1;
  }
}
