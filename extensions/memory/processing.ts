import fs from "node:fs/promises";
import path from "node:path";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { executeSubagentRun } from "../../src/core/subagent/service.js";
import { resolveAgentDir } from "./lib.js";
import { safeString } from "./core/utils.js";
import { RESIDENT_LIMITS, RESIDENT_SLOTS } from "./core/types.js";
import { loadMemoryDocs, residentPath } from "./docs.js";
import { resolveMemoryRoot } from "./store.js";

type MemoryProcessingSettings = {
  processingModel?: string;
};

type GeneralMemoryDraft = {
  name?: string;
  description?: string;
  content: string;
  exposure?: "progressive" | "recall";
  scope?: "global" | "domain" | "project" | "session";
  kind?:
    | "identity"
    | "style"
    | "method"
    | "value"
    | "preference"
    | "rule"
    | "knowledge"
    | "history";
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
  const configuredModel = safeString(settings?.memory?.processingModel).trim();
  const fallbackCurrent = ctx?.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : "";
  const fallbackDefault =
    safeString(settings?.defaultProvider).trim() &&
    safeString(settings?.defaultModel).trim()
      ? `${safeString(settings.defaultProvider).trim()}/${safeString(settings.defaultModel).trim()}`
      : "";
  return {
    processingModel:
      configuredModel || fallbackCurrent || fallbackDefault || undefined,
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
      thinkingLevel: options.currentThinkingLevel,
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

export async function normalizeGeneralMemoryDraft(options: {
  ctx: any;
  currentThinkingLevel: ThinkingLevel;
  draft: GeneralMemoryDraft;
}) {
  const settings = await resolveMemoryProcessingSettings(options.ctx);
  const { output } = await runMemoryProcessor({
    ctx: options.ctx,
    currentThinkingLevel: options.currentThinkingLevel,
    processingModel: settings.processingModel,
    prompt: [
      "You normalize a memory document draft.",
      "Return JSON only.",
      "Schema:",
      '{"name":string,"description":string,"content":string}',
      "Rules:",
      "- Write all fields in English.",
      "- Preserve facts and meaning; do not invent details.",
      "- Keep the name short and reusable.",
      "- Keep description to one concise sentence when possible.",
      "- Keep content concise, stable, and searchable.",
      "- Output plain markdown/text in content, not YAML or code fences.",
      "Draft:",
      JSON.stringify(options.draft, null, 2),
    ].join("\n"),
  });
  const parsed = extractJson(output);
  const content = safeString(parsed?.content).trim();
  if (!content) throw new Error("memory_processing_invalid_content");
  return {
    name: safeString(parsed?.name).trim(),
    description: safeString(parsed?.description).trim(),
    content,
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
      "Rewrite the text in English, refining the wording, merging duplicates, and resolving conflicts by prioritizing later items, then output only the final content.",
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
