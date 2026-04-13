import type { AgentMessage as Message } from "@mariozechner/pi-agent-core";

import type { TaskResult, UsageStats } from "../../src/core/subagent/types.js";

export type { TaskResult, UsageStats };

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

function formatSessionSummary(result: TaskResult): string {
  if (!result.sessionPersisted) return "";
  const label = result.sessionName || result.sessionId || result.sessionFile;
  return label ? ` session=${label}` : " session=persisted";
}

export function summarizeTaskResult(result: TaskResult): string {
  const model = result.model || result.requestedModel || "(default model)";
  const preview = (result.output || result.errorMessage || "(no output)")
    .replace(/\s+/g, " ")
    .trim();
  return `${result.index}. [${result.status}] ${model}${formatSessionSummary(result)} — ${preview.slice(0, 180)}${preview.length > 180 ? "…" : ""}`;
}

export function buildSubagentAgentText(results: TaskResult[]): string {
  if (results.length === 1) {
    const single = results[0];
    return [
      single.output || single.errorMessage || "(no output)",
      single.sessionPersisted
        ? [
            "",
            `Session: ${single.sessionName || single.sessionId || single.sessionFile || "persisted"}`,
            single.sessionFile ? `Path: ${single.sessionFile}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return results
    .map((result) => {
      const model = result.model || result.requestedModel || "(default model)";
      const sessionLabel = result.sessionPersisted
        ? result.sessionName || result.sessionId || result.sessionFile
        : "";
      return [
        `${result.index}. ${model}${sessionLabel ? ` [session: ${sessionLabel}]` : ""}`,
        result.output || result.errorMessage || "(no output)",
      ]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n");
}
