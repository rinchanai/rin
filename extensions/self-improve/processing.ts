import { safeString } from "./core/utils.js";
import { MEMORY_PROMPT_LIMITS, MEMORY_PROMPT_SLOTS } from "./core/types.js";

export type SelfImprovePromptAction = "add" | "replace" | "remove";

function countSubstringMatches(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const idx = text.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + Math.max(needle.length, 1);
  }
  return count;
}

function applySlotAction(options: {
  action: SelfImprovePromptAction;
  existingContent: string;
  incomingContent: string;
  oldText: string;
}) {
  const action = options.action;
  const existingContent = safeString(options.existingContent).trim();
  const incomingContent = safeString(options.incomingContent).trim();
  const oldText = safeString(options.oldText).trim();

  if (action === "add") {
    if (!incomingContent)
      throw new Error("self_improve_prompt_content_required:add");
    return [existingContent, incomingContent].filter(Boolean).join("\n");
  }

  if (!oldText)
    throw new Error(`self_improve_prompt_old_text_required:${action}`);
  if (!existingContent)
    throw new Error(`self_improve_prompt_slot_empty:${action}`);

  const matchCount = countSubstringMatches(existingContent, oldText);
  if (matchCount === 0)
    throw new Error(`self_improve_prompt_old_text_not_found:${action}`);
  if (matchCount > 1)
    throw new Error(`self_improve_prompt_old_text_ambiguous:${action}`);

  if (action === "replace") {
    if (!incomingContent)
      throw new Error("self_improve_prompt_content_required:replace");
    return existingContent.replace(oldText, incomingContent).trim();
  }

  return existingContent.replace(oldText, " ").replace(/\s+/g, " ").trim();
}

export async function refineSelfImprovePromptSlot(options: {
  selfImprovePromptSlot: string;
  incomingContent?: string;
  existingContent?: string;
  action?: SelfImprovePromptAction;
  oldText?: string;
}) {
  const slot = safeString(options.selfImprovePromptSlot).trim();
  if (!MEMORY_PROMPT_SLOTS.includes(slot as any)) {
    throw new Error(
      `self_improve_prompt_slot_required:${MEMORY_PROMPT_SLOTS.join(",")}`,
    );
  }

  const content = applySlotAction({
    action: (options.action || "add") as SelfImprovePromptAction,
    existingContent: safeString(options.existingContent).trim(),
    incomingContent: safeString(options.incomingContent).trim(),
    oldText: safeString(options.oldText).trim(),
  });

  const limits = MEMORY_PROMPT_LIMITS[slot];
  if (content.length > limits.maxChars) {
    throw new Error(
      `self_improve_prompt_content_too_long:${slot}:${limits.maxChars}`,
    );
  }

  return {
    name: slot.replace(/_/g, " "),
    content,
    removed: !content,
  };
}
