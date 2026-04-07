import fs from "node:fs/promises";
import path from "node:path";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { executeSubagentRun } from "../../src/core/subagent/service.js";
import { resolveAgentDir } from "./lib.js";
import { safeString } from "./core/utils.js";
import { MEMORY_PROMPT_LIMITS, MEMORY_PROMPT_SLOTS } from "./core/types.js";
import { loadMemoryDocs, memoryPromptPath } from "./docs.js";
import { resolveMemoryRoot } from "./store.js";

type MemoryProcessingSettings = {
  processingModel?: string;
  thinkingLevel?: ThinkingLevel;
};

function extractPlainText(text: string): string {
  const raw = safeString(text).trim();
  if (!raw) return "";
  const fenced = raw.match(/^```(?:[\w-]+)?\s*\n?([\s\S]*?)\n?```$/);
  return safeString(fenced?.[1] || raw).trim();
}

async function readSettingsJson() {
  const settingsPath = path.join(resolveAgentDir(), "settings.json");
  try {
    return JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

export async function resolveMemoryProcessingSettings(
  ctx: any,
): Promise<MemoryProcessingSettings> {
  const settings = await readSettingsJson();
  const memoryProvider = safeString(settings?.memory?.provider).trim();
  const memoryModel = safeString(settings?.memory?.model).trim();
  const legacyProcessingModel = safeString(
    settings?.memory?.processingModel,
  ).trim();
  const fallbackCurrent = ctx?.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : "";
  const fallbackDefault =
    safeString(settings?.defaultProvider).trim() &&
    safeString(settings?.defaultModel).trim()
      ? `${safeString(settings.defaultProvider).trim()}/${safeString(settings.defaultModel).trim()}`
      : "";
  const configuredModel =
    memoryProvider && memoryModel
      ? `${memoryProvider}/${memoryModel}`
      : legacyProcessingModel;
  const thinkingLevel = safeString(settings?.memory?.thinking).trim();
  return {
    processingModel:
      configuredModel || fallbackCurrent || fallbackDefault || undefined,
    thinkingLevel: thinkingLevel ? (thinkingLevel as ThinkingLevel) : undefined,
  };
}

async function runMemoryProcessor(options: {
  ctx: any;
  currentThinkingLevel: ThinkingLevel;
  prompt: string;
  processingModel?: string;
}) {
  const settings = await resolveMemoryProcessingSettings(options.ctx);
  const run = await executeSubagentRun({
    params: {
      prompt: options.prompt,
      model: options.processingModel || settings.processingModel,
      thinkingLevel: settings.thinkingLevel || options.currentThinkingLevel,
    },
    ctx: options.ctx,
    currentThinkingLevel: options.currentThinkingLevel,
  });
  if (run.ok === false)
    throw new Error(run.error || "memory_processing_failed");
  const output = safeString(
    run.results[0]?.output || run.results[0]?.errorMessage,
  );
  if (!output.trim()) throw new Error("memory_processing_empty_output");
  return { output, settings };
}

export async function refineMemoryPromptSlot(options: {
  ctx: any;
  currentThinkingLevel: ThinkingLevel;
  memoryPromptSlot: string;
  incomingContent: string;
  rootDir: string;
}) {
  const slot = safeString(options.memoryPromptSlot).trim();
  if (!MEMORY_PROMPT_SLOTS.includes(slot as any)) {
    throw new Error(
      `memory_prompt_slot_required:${MEMORY_PROMPT_SLOTS.join(",")}`,
    );
  }
  const root = resolveMemoryRoot(options.rootDir);
  const docs = await loadMemoryDocs(root);
  const existing = docs.find(
    (doc) =>
      doc.exposure === "memory_prompts" && doc.memory_prompt_slot === slot,
  );
  const appended = [
    safeString(existing?.content).trim(),
    safeString(options.incomingContent).trim(),
  ]
    .filter(Boolean)
    .join("\n");
  const limits = MEMORY_PROMPT_LIMITS[slot];
  const settings = await resolveMemoryProcessingSettings(options.ctx);
  const { output } = await runMemoryProcessor({
    ctx: options.ctx,
    currentThinkingLevel: options.currentThinkingLevel,
    processingModel: settings.processingModel,
    prompt: [
      `Produce a short, stable, always-on routing cue for the ${slot} memory prompt slot. Keep it compact, durable, and easy to route from. Resolve conflicts in favor of later items. Return only the final content.`,
      appended,
    ].join("\n\n"),
  });
  const content = extractPlainText(output);
  if (!content) throw new Error("memory_prompt_processing_invalid_content");
  if (content.length > limits.maxChars) {
    throw new Error(
      `memory_prompt_content_too_long:${slot}:${limits.maxChars}`,
    );
  }
  return {
    name: slot.replace(/_/g, " "),
    content,
    path: memoryPromptPath(root, slot),
    previousContent: safeString(existing?.content).trim(),
    language: "english",
  };
}

export function resolveConfiguredMemoryModelRefForTest(settings: any): string {
  const configuredModel = safeString(settings?.memory?.processingModel).trim();
  const fallbackDefault =
    safeString(settings?.defaultProvider).trim() &&
    safeString(settings?.defaultModel).trim()
      ? `${safeString(settings.defaultProvider).trim()}/${safeString(settings.defaultModel).trim()}`
      : "";
  return configuredModel || fallbackDefault || "";
}
