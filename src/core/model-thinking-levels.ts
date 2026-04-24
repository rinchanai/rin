import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

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

export function computeAvailableThinkingLevels(model: {
  provider?: string | null;
  id?: string | null;
  reasoning?: boolean | null;
}) {
  if (!model?.reasoning) return [...OFF_ONLY_THINKING_LEVELS];
  const id = String(model.id || "").toLowerCase();
  return id.includes("codex-max")
    ? [...MAX_REASONING_THINKING_LEVELS]
    : [...STANDARD_REASONING_THINKING_LEVELS];
}
