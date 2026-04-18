import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { Type } from "@sinclair/typebox";

import {
  buildCompiledSelfImprovePrompt,
  buildSystemPromptSelfImprove,
  formatSelfImproveAgentResult,
  formatSelfImproveResult,
} from "./format.js";
import {
  buildOnboardingPrompt,
  getOnboardingState,
  isOnboardingActive,
  markOnboardingPrompted,
  refreshOnboardingCompletion,
} from "./onboarding.js";
import { resolveRuntimeProfile } from "../rin-lib/runtime.js";

export const SAVE_PROMPTS_SLOT_GUIDANCE = "Choose the slot by ownership and meaning: `agent_profile` is the assistant's own stable identity, relationship framing, tone, and recurring behavior style; `user_profile` is stable knowledge about the user and how to address them; `core_doctrine` is standing methods, priorities, values, and decision rules; `core_facts` is durable external facts, environment facts, project conventions, and preferences that are not the user's identity.";
export const SAVE_PROMPTS_REWRITE_GUIDANCE = "When new durable information overlaps an existing slot, read that slot first and rewrite the full canonical slot with merged, deduplicated, up-to-date lines instead of appending fragments or leaving stale lines behind.";
export const SAVE_PROMPTS_SLOT_DESCRIPTION = `Which always-on prompt slot to inspect or update. ${SAVE_PROMPTS_SLOT_GUIDANCE}`;
export const SAVE_PROMPTS_CONTENT_DESCRIPTION = "Full revised canonical content for the slot. Use one line per topic. Keep the wording concise and information-dense. Omit this on the first call to read the current slot state. When updating an existing slot, submit the full merged slot content, not just the delta.";
export const SAVE_PROMPTS_BASE_CONTENT_DESCRIPTION = "Current canonical content returned by the read step. Before updating a populated slot, first call save_prompts with only `slot` to read the current canonical content. Then pass that returned content here exactly as `baseContent`. Treat the read result as canonical. Keep `content` in the same normalized shape unless you intentionally want save_prompts to re-normalize it.";
export const SAVE_PROMPTS_PROMPT_GUIDELINES = [
  "Use save_prompts proactively for durable baselines such as recurring corrections, environment conventions, stable facts, and other long-lived guidance that should remain active every turn.",
  SAVE_PROMPTS_SLOT_GUIDANCE,
  SAVE_PROMPTS_REWRITE_GUIDANCE,
  "Use save_prompts only for compact long-lived prompt content; do not store task progress, session outcomes, or temporary state with save_prompts.",
];

export function resolveAgentDir() {
  return resolveRuntimeProfile().agentDir;
}

export const selfImproveActionParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("save_self_improve_prompt"),
      Type.Literal("remove_self_improve_prompt"),
      Type.Literal("compile"),
    ],
    {
      description:
        "Self-improve action. Allowed values: `save_self_improve_prompt`, `remove_self_improve_prompt`, or `compile`.",
    },
  ),
  id: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  aliases: Type.Optional(Type.Array(Type.String())),
  selfImprovePromptSlot: Type.Optional(
    Type.Union(
      [
        Type.Literal("agent_profile"),
        Type.Literal("user_profile"),
        Type.Literal("core_doctrine"),
        Type.Literal("core_facts"),
      ],
      {
        description:
          "Self-improve prompt slot name. Allowed values: `agent_profile`, `user_profile`, `core_doctrine`, `core_facts`.",
      },
    ),
  ),
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal("global"),
        Type.Literal("domain"),
        Type.Literal("project"),
        Type.Literal("session"),
      ],
      {
        description:
          "Optional self-improve scope. Allowed values: `global`, `domain`, `project`, or `session`.",
      },
    ),
  ),
  kind: Type.Optional(
    Type.Union(
      [
        Type.Literal("skill"),
        Type.Literal("instruction"),
        Type.Literal("rule"),
        Type.Literal("fact"),
        Type.Literal("index"),
      ],
      {
        description:
          "Optional self-improve kind. Allowed values: `skill`, `instruction`, `rule`, `fact`, or `index`.",
      },
    ),
  ),
});

export async function loadSelfImproveStore() {
  const moduleUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "store.js"),
  ).href;
  return await import(moduleUrl);
}

export async function executeSelfImproveTool(params: any) {
  const service = await loadSelfImproveStore();
  return await service.executeSelfImproveAction(params, resolveAgentDir());
}

export {
  buildOnboardingPrompt,
  formatSelfImproveAgentResult,
  formatSelfImproveResult,
  getOnboardingState,
  isOnboardingActive,
  markOnboardingPrompted,
  refreshOnboardingCompletion,
};

export async function compileSelfImprovePrompt() {
  const service = await loadSelfImproveStore();
  const compiled = await service.compileSelfImprove({}, resolveAgentDir());
  return {
    compiled,
    prompt: buildCompiledSelfImprovePrompt(compiled),
    systemPrompt: buildSystemPromptSelfImprove(compiled),
  };
}
