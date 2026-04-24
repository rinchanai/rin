import type { AgentMessage as Message } from "@mariozechner/pi-agent-core";

import { NO_OUTPUT_TEXT } from "../pi/render-utils.js";
import type { TaskResult, UsageStats } from "./types.js";

export type { TaskResult, UsageStats };

const DEFAULT_MODEL_LABEL = "(default model)";
const FALLBACK_SESSION_LABEL = "persisted";
const DEFAULT_PREVIEW_LENGTH = 180;
const USER_PREVIEW_LENGTH = 220;

type TaskSessionIdentity = Pick<
  TaskResult,
  "sessionPersisted" | "sessionName" | "sessionId" | "sessionFile"
>;

type TaskModelIdentity = Pick<TaskResult, "model" | "requestedModel">;

type TaskTextIdentity = Pick<TaskResult, "output" | "errorMessage">;

type TaskHeadingResult = Pick<
  TaskResult,
  | "index"
  | "status"
  | "model"
  | "requestedModel"
  | "sessionPersisted"
  | "sessionName"
  | "sessionId"
  | "sessionFile"
>;

function trimText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeText(
  value: unknown,
  options: { singleLine?: boolean } = {},
): string {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  return options.singleLine ? text.replace(/\s+/g, " ") : text;
}

function normalizePreviewText(value: unknown): string {
  return normalizeText(value, { singleLine: true });
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function getTaskSessionIdentity(result: TaskSessionIdentity): {
  label: string | undefined;
  filePath: string;
} {
  if (!result.sessionPersisted) {
    return { label: undefined, filePath: "" };
  }

  return {
    label:
      trimText(result.sessionName) ||
      trimText(result.sessionId) ||
      trimText(result.sessionFile) ||
      FALLBACK_SESSION_LABEL,
    filePath: trimText(result.sessionFile),
  };
}

function formatTaskSessionHeadingPart(
  label: string | undefined,
  sessionFormat?: "equals" | "brackets",
): string {
  if (!label) return "";
  if (sessionFormat === "equals") return `session=${label}`;
  if (sessionFormat === "brackets") return `[session: ${label}]`;
  return "";
}

function formatTaskSessionDetails(result: TaskSessionIdentity): string[] {
  const session = getTaskSessionIdentity(result);
  if (!session.label) return [];
  return [
    `Session: ${session.label}`,
    session.filePath ? `Path: ${session.filePath}` : "",
  ].filter(Boolean);
}

function buildTaskPreviewLine(
  result: TaskResult,
  options: {
    status?: string;
    sessionFormat?: "equals" | "brackets";
    maxLength?: number;
  },
): string {
  return `${buildTaskHeading(result, options)} — ${getTaskPreview(
    result,
    options.maxLength,
  )}`;
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
  if (isPositiveNumber(usage.input))
    parts.push(`↑${formatTokens(usage.input)}`);
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
    const text = normalizeText(
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

export function getTaskPrimaryText(result: TaskTextIdentity): string {
  return (
    normalizeText(result.output) ||
    normalizeText(result.errorMessage) ||
    NO_OUTPUT_TEXT
  );
}

export function getTaskSessionLabel(
  result: TaskSessionIdentity,
): string | undefined {
  return getTaskSessionIdentity(result).label;
}

export function getTaskModelLabel(result: TaskModelIdentity): string {
  return (
    trimText(result.model) ||
    trimText(result.requestedModel) ||
    DEFAULT_MODEL_LABEL
  );
}

export function getTaskPreview(
  result: TaskTextIdentity,
  maxLength = DEFAULT_PREVIEW_LENGTH,
): string {
  const preview = normalizePreviewText(getTaskPrimaryText(result));
  return `${preview.slice(0, maxLength)}${preview.length > maxLength ? "…" : ""}`;
}

function buildTaskHeading(
  result: TaskHeadingResult,
  options?: {
    status?: string;
    sessionFormat?: "equals" | "brackets";
  },
): string {
  return [
    `${result.index}.`,
    trimText(options?.status) ? `[${trimText(options?.status)}]` : "",
    getTaskModelLabel(result),
    formatTaskSessionHeadingPart(
      getTaskSessionIdentity(result).label,
      options?.sessionFormat,
    ),
  ]
    .filter(Boolean)
    .join(" ");
}

function buildSingleResultText(result: TaskResult): string {
  const sessionDetails = formatTaskSessionDetails(result);
  return [
    getTaskPrimaryText(result),
    sessionDetails.length > 0 ? sessionDetails.join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function summarizeTaskResult(result: TaskResult): string {
  return buildTaskPreviewLine(result, {
    status: result.status,
    sessionFormat: "equals",
  });
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
      buildTaskPreviewLine(result, {
        status: result.exitCode === 0 ? "ok" : "failed",
        sessionFormat: "brackets",
        maxLength: USER_PREVIEW_LENGTH,
      }),
    ),
  ].join("\n\n");
}
