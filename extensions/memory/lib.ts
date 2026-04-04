import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Type } from "@sinclair/typebox";

import {
  buildCompiledMemoryPrompt,
  buildSystemPromptMemory,
  formatMemoryAgentResult,
  formatMemoryResult,
} from "./format.js";
import {
  buildOnboardingPrompt as buildOnboardingPromptBase,
  getOnboardingState as getOnboardingStateBase,
  getOnboardingStatus as getOnboardingStatusBase,
  isOnboardingActive as isOnboardingActiveBase,
  markOnboardingPrompted as markOnboardingPromptedBase,
  refreshOnboardingCompletion as refreshOnboardingCompletionBase,
} from "./onboarding.js";

export const memoryToolParameters = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("search"),
      Type.Literal("save"),
      Type.Literal("save_resident"),
    ],
    {
      description:
        "Memory tool action. Allowed values: `list`, `search`, `save`, or `save_resident`.",
    },
  ),
  query: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  exposure: Type.Optional(
    Type.Union([Type.Literal("progressive"), Type.Literal("recall")], {
      description:
        "Optional memory layer. Allowed values: `progressive` or `recall`.",
    }),
  ),
  fidelity: Type.Optional(
    Type.Union([Type.Literal("exact"), Type.Literal("fuzzy")], {
      description:
        "Optional match fidelity. Allowed values: `exact` or `fuzzy` only.",
    }),
  ),
  residentSlot: Type.Optional(
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
          "Resident slot name. Use only with `exposure: resident`. Allowed values: `agent_identity`, `owner_identity`, `core_voice_style`, `core_methodology`, `core_values`.",
      },
    ),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
  aliases: Type.Optional(Type.Array(Type.String())),
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
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("active"),
        Type.Literal("superseded"),
        Type.Literal("invalidated"),
      ],
      {
        description:
          "Optional memory status. Allowed values: `active`, `superseded`, or `invalidated`.",
      },
    ),
  ),
  observationCount: Type.Optional(Type.Number({ minimum: 1 })),
  supersedes: Type.Optional(Type.Array(Type.String())),
  sensitivity: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Maximum number of matches to return.",
    }),
  ),
});

export function resolveAgentDir(): string {
  const fromEnv = String(
    process.env.PI_CODING_AGENT_DIR || process.env.RIN_DIR || "",
  ).trim();
  return fromEnv
    ? path.resolve(fromEnv)
    : path.join(process.env.HOME || "", ".rin");
}

export {
  buildCompiledMemoryPrompt,
  buildSystemPromptMemory,
  formatMemoryResult,
  formatMemoryAgentResult,
};

export function buildOnboardingPrompt(
  mode: "auto" | "manual" = "manual",
): string {
  return buildOnboardingPromptBase(mode);
}

export function getOnboardingState() {
  return getOnboardingStateBase(resolveAgentDir);
}

export function isOnboardingActive(
  state = getOnboardingStateBase(resolveAgentDir),
) {
  return isOnboardingActiveBase(resolveAgentDir, state);
}

export async function getOnboardingStatus() {
  return await getOnboardingStatusBase(resolveAgentDir, loadMemoryService);
}

export async function markOnboardingPrompted(trigger: string) {
  return await markOnboardingPromptedBase(resolveAgentDir, trigger);
}

export async function refreshOnboardingCompletion() {
  return await refreshOnboardingCompletionBase(
    resolveAgentDir,
    loadMemoryService,
  );
}

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

export async function compilePromptMemory(query = "") {
  const service = await loadMemoryService();
  const compiled = await service.compileMemory(
    {
      query,
      progressiveLimit: 12,
      expandedProgressiveLimit: 2,
      recallLimit: 3,
      historyLimit: 3,
    },
    resolveAgentDir(),
  );
  return {
    compiled,
    prompt: buildCompiledMemoryPrompt(compiled),
    systemPrompt: buildSystemPromptMemory(compiled),
  };
}
