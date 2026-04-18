import type { AgentMessage as Message } from "@mariozechner/pi-agent-core";

import type { TaskResult, UsageStats } from "./types.js";

export type { TaskResult, UsageStats };

const NO_OUTPUT = "(no output)";
const DEFAULT_MODEL_LABEL = "(default model)";
const FALLBACK_SESSION_LABEL = "persisted";

export function formatTokens(value: number): string {
  if (!value) return "0";
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export function getTaskPrimaryText(
  result: Pick<TaskResult, "output" | "errorMessage">,
): string {
  return result.output || result.errorMessage || NO_OUTPUT;
}

export function getTaskSessionLabel(
  result: Pick<
    TaskResult,
    "sessionPersisted" | "sessionName" | "sessionId" | "sessionFile"
  >,
): string | undefined {
  if (!result.sessionPersisted) return undefined;
  return (
    result.sessionName ||
    result.sessionId ||
    result.sessionFile ||
    FALLBACK_SESSION_LABEL
  );
}

export function getTaskModelLabel(
  result: Pick<TaskResult, "model" | "requestedModel">,
): string {
  return result.model || result.requestedModel || DEFAULT_MODEL_LABEL;
}

export function getTaskPreview(
  result: Pick<TaskResult, "output" | "errorMessage">,
  maxLength = 180,
): string {
  const preview = getTaskPrimaryText(result)
    .replace(/\s+/g, " ")
    .trim();
  return `${preview.slice(0, maxLength)}${preview.length > maxLength ? "…" : ""}`;
}

function buildSingleResultText(result: TaskResult): string {
  const sessionLabel = getTaskSessionLabel(result);
  return [
    getTaskPrimaryText(result),
    sessionLabel
      ? [
          "",
          `Session: ${sessionLabel}`,
          result.sessionFile ? `Path: ${result.sessionFile}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function summarizeTaskResult(result: TaskResult): string {
  const sessionLabel = getTaskSessionLabel(result);
  return `${result.index}. [${result.status}] ${getTaskModelLabel(result)}${sessionLabel ? ` session=${sessionLabel}` : ""} — ${getTaskPreview(result)}`;
}

export function buildSubagentAgentText(results: TaskResult[]): string {
  if (results.length === 1) {
    return buildSingleResultText(results[0]);
  }

  return results
    .map((result) => {
      const sessionLabel = getTaskSessionLabel(result);
      return [
        `${result.index}. ${getTaskModelLabel(result)}${sessionLabel ? ` [session: ${sessionLabel}]` : ""}`,
        getTaskPrimaryText(result),
      ]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n");
}

export function buildSubagentUserText(results: TaskResult[]): string {
  const failed = results.filter((result) => result.exitCode !== 0);
  if (results.length === 1) {
    return buildSingleResultText(results[0]);
  }

  return [
    `Parallel subagents finished: ${results.length - failed.length}/${results.length} succeeded`,
    ...results.map((result) => {
      const status = result.exitCode === 0 ? "ok" : "failed";
      const sessionLabel = getTaskSessionLabel(result);
      const suffix = sessionLabel ? ` [session: ${sessionLabel}]` : "";
      return `${result.index}. [${status}] ${getTaskModelLabel(result)}${suffix} — ${getTaskPreview(result, 220)}`;
    }),
  ].join("\n\n");
}
