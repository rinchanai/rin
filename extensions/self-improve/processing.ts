import { safeString } from "./core/utils.js";
import { MEMORY_PROMPT_LIMITS, MEMORY_PROMPT_SLOTS } from "./core/types.js";

export function normalizePromptListContent(text: string) {
  return safeString(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n")
    .trim();
}

export function assertSelfImprovePromptSlot(slotInput: string) {
  const slot = safeString(slotInput).trim();
  if (!MEMORY_PROMPT_SLOTS.includes(slot as any)) {
    throw new Error(
      `self_improve_prompt_slot_required:${MEMORY_PROMPT_SLOTS.join(",")}`,
    );
  }
  return slot;
}

export function describeSelfImprovePromptSlot(options: {
  slot: string;
  existingContent?: string;
}) {
  const slot = assertSelfImprovePromptSlot(options.slot);
  const content = normalizePromptListContent(options.existingContent || "");
  const limits = MEMORY_PROMPT_LIMITS[slot];
  return {
    slot,
    name: slot.replace(/_/g, " "),
    content,
    currentChars: content.length,
    maxChars: limits.maxChars,
  };
}

export function refineSelfImprovePromptSlot(options: {
  slot: string;
  incomingContent?: string;
}) {
  const state = describeSelfImprovePromptSlot({
    slot: options.slot,
  });
  const content = normalizePromptListContent(options.incomingContent || "");
  if (!content) throw new Error("self_improve_content_required");
  if (content.length > state.maxChars) {
    throw new Error(
      `self_improve_prompt_content_too_long:${state.slot}:${state.maxChars}`,
    );
  }
  return {
    ...state,
    content,
    nextChars: content.length,
  };
}
