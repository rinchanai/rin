import fs from "node:fs/promises";
import path from "node:path";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { executeSubagentRun } from "../../src/core/subagent/service.js";
import { resolveAgentDir } from "./lib.js";
import { safeString, sha, slugify } from "./core/utils.js";
import { RESIDENT_LIMITS, RESIDENT_SLOTS } from "./core/types.js";
import { genericDocPath, loadMemoryDocs, residentPath } from "./docs.js";
import { resolveMemoryRoot } from "./store.js";

type MemoryProcessingSettings = {
  processingModel?: string;
  thinkingLevel?: ThinkingLevel;
};

export type GeneralMemoryDraft = {
  name?: string;
  description?: string;
  content: string;
  exposure?: "progressive" | "recall";
  scope?: "global" | "domain" | "project" | "session";
  kind?: "skill" | "instruction" | "rule" | "fact" | "index";
  path?: string;
};

function extractJson(text: string): any {
  const raw = safeString(text).trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return {};
}

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
  const exposure = "recall";
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

export async function refineResidentSlot(options: {
  ctx: any;
  currentThinkingLevel: ThinkingLevel;
  residentSlot: string;
  incomingContent: string;
  rootDir: string;
}) {
  const slot = safeString(options.residentSlot).trim();
  if (!RESIDENT_SLOTS.includes(slot as any)) {
    throw new Error(`resident_slot_required:${RESIDENT_SLOTS.join(",")}`);
  }
  const root = resolveMemoryRoot(options.rootDir);
  const docs = await loadMemoryDocs(root);
  const existing = docs.find(
    (doc) => doc.exposure === "resident" && doc.resident_slot === slot,
  );
  const appended = [
    safeString(existing?.content).trim(),
    safeString(options.incomingContent).trim(),
  ]
    .filter(Boolean)
    .join("\n");
  const limits = RESIDENT_LIMITS[slot];
  const settings = await resolveMemoryProcessingSettings(options.ctx);
  const { output } = await runMemoryProcessor({
    ctx: options.ctx,
    currentThinkingLevel: options.currentThinkingLevel,
    processingModel: settings.processingModel,
    prompt: [
      "Refine the wording, merge duplicates, and resolve conflicts in favor of later items, returning only the final content.",
      appended,
    ].join("\n\n"),
  });
  const content = extractPlainText(output);
  if (!content) throw new Error("resident_processing_invalid_content");
  return {
    name: slot.replace(/_/g, " "),
    content,
    path: residentPath(root, slot),
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
