import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { Type } from "@sinclair/typebox";

import {
  buildCompiledMemoryPrompt,
  buildSystemPromptMemory,
  formatMemoryAgentResult,
  formatMemoryResult,
} from "./format.js";
import {
  buildOnboardingPrompt,
  getOnboardingState,
  isOnboardingActive,
  markOnboardingPrompted,
  refreshOnboardingCompletion,
} from "./onboarding.js";
import { resolveRuntimeProfile } from "../../src/core/rin-lib/runtime.js";

export function resolveAgentDir() {
  return resolveRuntimeProfile().agentDir;
}

export const memoryActionParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("search"),
      Type.Literal("save"),
      Type.Literal("save_memory_prompt"),
      Type.Literal("compile"),
      Type.Literal("doctor"),
    ],
    {
      description:
        "Memory tool action. Allowed values: `list`, `search`, `save`, `save_memory_prompt`, `compile`, or `doctor`.",
    },
  ),
  query: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  fidelity: Type.Optional(
    Type.Union([Type.Literal("exact"), Type.Literal("fuzzy")]),
  ),
  id: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  exposure: Type.Optional(
    Type.Literal("memory_docs", {
      description:
        "Optional memory layer. Normal searchable memory uses `memory_docs`.",
    }),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
  aliases: Type.Optional(Type.Array(Type.String())),
  memoryPromptSlot: Type.Optional(
    Type.Union(
      [
        Type.Literal("agent_identity"),
        Type.Literal("owner_identity"),
        Type.Literal("core_voice_style"),
        Type.Literal("core_methodology"),
        Type.Literal("core_values"),
      ],
      {
        description:
          "Memory prompt slot name. Allowed values: `agent_identity`, `owner_identity`, `core_voice_style`, `core_methodology`, `core_values`.",
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
          "Optional memory scope. Allowed values: `global`, `domain`, `project`, or `session`.",
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
          "Optional memory kind. Allowed values: `skill`, `instruction`, `rule`, `fact`, or `index`.",
      },
    ),
  ),
});

export async function loadMemoryService() {
  const moduleUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "store.js"),
  ).href;
  return await import(moduleUrl);
}

export async function executeMemoryTool(params: any) {
  const service = await loadMemoryService();
  return await service.executeMemoryAction(params, resolveAgentDir());
}

export {
  buildOnboardingPrompt,
  formatMemoryAgentResult,
  formatMemoryResult,
  getOnboardingState,
  isOnboardingActive,
  markOnboardingPrompted,
  refreshOnboardingCompletion,
};

export async function compilePromptMemory() {
  const service = await loadMemoryService();
  const compiled = await service.compileMemory({}, resolveAgentDir());
  return {
    compiled,
    prompt: buildCompiledMemoryPrompt(compiled),
    systemPrompt: buildSystemPromptMemory(compiled),
  };
}
