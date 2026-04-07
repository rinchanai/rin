import fs from "node:fs/promises";
import path from "node:path";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { executeSubagentRun } from "../../src/core/subagent/service.js";
import { resolveAgentDir } from "./lib.js";
import { safeString, sha, slugify } from "./core/utils.js";
import { MEMORY_PROMPT_LIMITS, MEMORY_PROMPT_SLOTS } from "./core/types.js";
import { genericDocPath, loadMemoryDocs, memoryPromptPath } from "./docs.js";
import { resolveMemoryRoot } from "./store.js";

type MemoryProcessingSettings = {
  processingModel?: string;
  thinkingLevel?: ThinkingLevel;
};

export type GeneralMemoryDraft = {
  name?: string;
  description?: string;
  content: string;
  exposure?: "memory_docs";
  scope?: "global" | "domain" | "project" | "session";
  kind?: "skill" | "instruction" | "rule" | "fact" | "index";
  path?: string;
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

export function buildMemoryDraftDoc(options: {
  rootDir: string;
  draft: GeneralMemoryDraft;
}) {
  const root = resolveMemoryRoot(options.rootDir);
  const exposure = "memory_docs";
  const name =
    safeString(options.draft.name || "").trim() ||
    safeString(options.draft.content || "")
      .split(/\r?\n/)[0]
      .trim()
      .slice(0, 80) ||
    "memory";
  const id = slugify(name, `memory-${sha(options.draft.content).slice(0, 8)}`);
  const targetPath = safeString(options.draft.path || "").trim()
    ? safeString(options.draft.path).trim()
    : genericDocPath(root, exposure, id);
  const kind = safeString(options.draft.kind || "fact").trim() || "fact";
  const scope = safeString(options.draft.scope || "").trim() || "project";
  const description = safeString(options.draft.description || "").trim();
  const content = safeString(options.draft.content || "").trim();
  const draftDoc = [
    "---",
    `name: ${name}`,
    ...(description ? [`description: ${description}`] : []),
    `exposure: ${exposure}`,
    `kind: ${kind}`,
    `scope: ${scope}`,
    "---",
    content,
    "",
  ].join("\n");
  return {
    root,
    path: targetPath,
    name,
    description,
    kind,
    exposure,
    scope,
    content,
    draftDoc,
  };
}

export async function writeMemoryDocWithSkillCreator(options: {
  ctx: any;
  currentThinkingLevel: ThinkingLevel;
  memoryRoot: string;
  draftDoc: string;
}) {
  const settings = await resolveMemoryProcessingSettings(options.ctx);
  const { output } = await runMemoryProcessor({
    ctx: options.ctx,
    currentThinkingLevel: options.currentThinkingLevel,
    processingModel: settings.processingModel,
    prompt: `Use the draft below to update the most relevant existing memory document or create a new one under ${options.memoryRoot}. Output only the saved file path.\n\nDraft:\n${options.draftDoc}`,
  });
  return {
    output: extractPlainText(output),
  };
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
