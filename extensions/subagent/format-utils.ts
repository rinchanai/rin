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

export function summarizeTaskResult(result: TaskResult): string {
  const model = result.model || result.requestedModel || "(default model)";
  const preview = (result.output || result.errorMessage || "(no output)")
    .replace(/\s+/g, " ")
    .trim();
  return `${result.index}. [${result.status}] ${model} — ${preview.slice(0, 180)}${preview.length > 180 ? "…" : ""}`;
}

export function buildSubagentAgentText(results: TaskResult[]): string {
  const failed = results.filter((result) => result.exitCode !== 0).length;
  return [
    `subagent results=${results.length} failed=${failed}`,
    ...results.map((result) => {
      const model = result.model || result.requestedModel || "(default model)";
      const preview = (result.output || result.errorMessage || "(no output)")
        .replace(/\s+/g, " ")
        .trim();
      return [
        `${result.index}. status=${result.status} exit=${result.exitCode} model=${model}`,
        `cwd=${result.cwd}`,
        preview
          ? `preview=${preview.slice(0, 220)}${preview.length > 220 ? "…" : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}
