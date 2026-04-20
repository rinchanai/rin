import { countToolCalls } from "../message-content.js";
import { readUsageMetrics } from "../usage-metrics.js";
import {
  calculateContextTokens,
  estimateContextTokens,
} from "./session-helpers.js";

function normalizeList<T>(value: T[] | undefined | null) {
  return Array.isArray(value) ? value : [];
}

function normalizeNonNegativeInteger(value: unknown) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.trunc(count));
}

function trimQueuedMessages(queue: string[], removeCount: number) {
  if (removeCount <= 0 || queue.length === 0) return 0;
  const nextRemoveCount = Math.min(queue.length, removeCount);
  queue.splice(0, nextRemoveCount);
  return nextRemoveCount;
}

export function getContextUsage(model: any, messages: any[], branch: any[]) {
  const contextWindow = Number(model?.contextWindow || 0);
  if (contextWindow <= 0) return undefined;

  const nextMessages = normalizeList(messages);
  const nextBranch = normalizeList(branch);

  let latestCompactionIndex = -1;
  for (let i = nextBranch.length - 1; i >= 0; i--) {
    if (nextBranch[i]?.type === "compaction") {
      latestCompactionIndex = i;
      break;
    }
  }

  if (latestCompactionIndex >= 0) {
    let hasPostCompactionUsage = false;
    for (let i = nextBranch.length - 1; i > latestCompactionIndex; i--) {
      const entry = nextBranch[i];
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

  const tokens = Number(estimateContextTokens(nextMessages) || 0);
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

  for (const entry of normalizeList(entries)) {
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
  const nextTargetCount = normalizeNonNegativeInteger(targetCount);
  let overflow =
    normalizeList(steeringMessages).length +
    normalizeList(followUpMessages).length -
    nextTargetCount;
  overflow -= trimQueuedMessages(steeringMessages, overflow);
  trimQueuedMessages(followUpMessages, overflow);
}
