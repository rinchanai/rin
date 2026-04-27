import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

type ThinkingLevelModel = {
  provider?: string | null;
  id?: string | null;
  reasoning?: boolean | null;
};

export const ALL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies ThinkingLevel[];

export type AvailableThinkingLevel = (typeof ALL_THINKING_LEVELS)[number];

const OFF_ONLY_THINKING_LEVELS = ["off"] as const satisfies ThinkingLevel[];
const STANDARD_REASONING_THINKING_LEVELS = ALL_THINKING_LEVELS.filter(
  (level) => level !== "xhigh",
);

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
    ? ALL_THINKING_LEVELS
    : STANDARD_REASONING_THINKING_LEVELS;
}

export function computeAvailableThinkingLevels(model: ThinkingLevelModel) {
  return [...resolveThinkingLevels(model)];
}
