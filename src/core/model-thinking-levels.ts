import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

type ThinkingLevelModel = {
  provider?: string | null;
  id?: string | null;
  reasoning?: boolean | null;
};

const OFF_ONLY_THINKING_LEVELS = ["off"] as const satisfies ThinkingLevel[];
const STANDARD_REASONING_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies ThinkingLevel[];
const MAX_REASONING_THINKING_LEVELS = [
  ...STANDARD_REASONING_THINKING_LEVELS,
  "xhigh",
] as const satisfies ThinkingLevel[];

function normalizeModelText(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function supportsMaxReasoningThinkingLevels(model: ThinkingLevelModel) {
  return (
    normalizeModelText(model?.provider) === "openai" &&
    normalizeModelText(model?.id).includes("codex-max")
  );
}

function resolveThinkingLevels(model: ThinkingLevelModel) {
  if (!model?.reasoning) return OFF_ONLY_THINKING_LEVELS;
  return supportsMaxReasoningThinkingLevels(model)
    ? MAX_REASONING_THINKING_LEVELS
    : STANDARD_REASONING_THINKING_LEVELS;
}

export function computeAvailableThinkingLevels(model: ThinkingLevelModel) {
  return [...resolveThinkingLevels(model)];
}
