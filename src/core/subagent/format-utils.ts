import type { AgentMessage as Message } from "@mariozechner/pi-agent-core";

import { NO_OUTPUT_TEXT } from "../pi/render-utils.js";
import type { TaskResult, UsageStats } from "./types.js";

export type { TaskResult, UsageStats };

const DEFAULT_MODEL_LABEL = "(default model)";
const FALLBACK_SESSION_LABEL = "persisted";
const DEFAULT_PREVIEW_LENGTH = 180;
const USER_PREVIEW_LENGTH = 220;

function trimText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeMultilineText(value: unknown): string {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function normalizePreviewText(value: unknown): string {
  return normalizeMultilineText(value).replace(/\s+/g, " ");
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function formatTokens(value: number): string {
  if (!isPositiveNumber(value)) return "0";
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (isPositiveNumber(usage.turns)) {
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  }
  if (isPositiveNumber(usage.input)) parts.push(`↑${formatTokens(usage.input)}`);
  if (isPositiveNumber(usage.output))
    parts.push(`↓${formatTokens(usage.output)}`);
  if (isPositiveNumber(usage.cacheRead))
    parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (isPositiveNumber(usage.cacheWrite))
    parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (isPositiveNumber(usage.cost)) parts.push(`$${usage.cost.toFixed(4)}`);
  if (isPositiveNumber(usage.contextTokens)) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  const modelLabel = trimText(model);
  if (modelLabel) parts.push(modelLabel);
  return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = normalizeMultilineText(
      Array.isArray(msg.content)
        ? msg.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        : "",
    );
    if (text) return text;
  }
  return "";
}

export function getTaskPrimaryText(
  result: Pick<TaskResult, "output" | "errorMessage">,
): string {
  return (
    normalizeMultilineText(result.output) ||
    normalizeMultilineText(result.errorMessage) ||
    NO_OUTPUT_TEXT
  );
}

export function getTaskSessionLabel(
  result: Pick<
    TaskResult,
    "sessionPersisted" | "sessionName" | "sessionId" | "sessionFile"
  >,
): string | undefined {
  if (!result.sessionPersisted) return undefined;
  return (
    trimText(result.sessionName) ||
    trimText(result.sessionId) ||
    trimText(result.sessionFile) ||
    FALLBACK_SESSION_LABEL
  );
}

export function getTaskModelLabel(
  result: Pick<TaskResult, "model" | "requestedModel">,
): string {
  return trimText(result.model) || trimText(result.requestedModel) || DEFAULT_MODEL_LABEL;
}

export function getTaskPreview(
  result: Pick<TaskResult, "output" | "errorMessage">,
  maxLength = DEFAULT_PREVIEW_LENGTH,
): string {
  const preview = normalizePreviewText(getTaskPrimaryText(result));
  return `${preview.slice(0, maxLength)}${preview.length > maxLength ? "…" : ""}`;
}

function getTaskSessionDetails(
  result: Pick<
    TaskResult,
    "sessionPersisted" | "sessionName" | "sessionId" | "sessionFile"
  >,
): string[] {
  const sessionLabel = getTaskSessionLabel(result);
  const sessionFile = trimText(result.sessionFile);
  if (!sessionLabel) return [];
  return [
    `Session: ${sessionLabel}`,
    sessionFile ? `Path: ${sessionFile}` : "",
  ].filter(Boolean);
}

function buildTaskHeading(
  result: Pick<
    TaskResult,
    | "index"
    | "status"
    | "model"
    | "requestedModel"
    | "sessionPersisted"
    | "sessionName"
    | "sessionId"
    | "sessionFile"
  >,
  options?: {
    status?: string;
    sessionFormat?: "equals" | "brackets";
  },
): string {
  const parts = [`${result.index}.`];
  const status = trimText(options?.status);
  if (status) parts.push(`[${status}]`);
  parts.push(getTaskModelLabel(result));
  const sessionLabel = getTaskSessionLabel(result);
  if (sessionLabel && options?.sessionFormat === "equals") {
    parts.push(`session=${sessionLabel}`);
  }
  if (sessionLabel && options?.sessionFormat === "brackets") {
    parts.push(`[session: ${sessionLabel}]`);
  }
  return parts.join(" ");
}

function buildSingleResultText(result: TaskResult): string {
  const sessionDetails = getTaskSessionDetails(result);
  return [
    getTaskPrimaryText(result),
    sessionDetails.length > 0 ? sessionDetails.join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function summarizeTaskResult(result: TaskResult): string {
  return `${buildTaskHeading(result, {
    status: result.status,
    sessionFormat: "equals",
  })} — ${getTaskPreview(result)}`;
}

export function buildSubagentAgentText(results: TaskResult[]): string {
  if (results.length === 1) {
    return buildSingleResultText(results[0]);
  }

  return results
    .map((result) =>
      [
        buildTaskHeading(result, { sessionFormat: "brackets" }),
        getTaskPrimaryText(result),
      ].join("\n\n"),
    )
    .join("\n\n");
}

export function buildSubagentUserText(results: TaskResult[]): string {
  const failed = results.filter((result) => result.exitCode !== 0);
  if (results.length === 1) {
    return buildSingleResultText(results[0]);
  }

  return [
    `Parallel subagents finished: ${results.length - failed.length}/${results.length} succeeded`,
    ...results.map((result) =>
      `${buildTaskHeading(result, {
        status: result.exitCode === 0 ? "ok" : "failed",
        sessionFormat: "brackets",
      })} — ${getTaskPreview(result, USER_PREVIEW_LENGTH)}`,
    ),
  ].join("\n\n");
}
