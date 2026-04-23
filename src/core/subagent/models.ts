import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import type { ProviderModelSummary } from "./types.js";

export const VALID_SUBAGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies ThinkingLevel[];

function trimText(value: unknown) {
  return String(value || "").trim();
}

function normalizeModelRefText(value: unknown) {
  return trimText(value).replace(/^@/, "");
}

function normalizeModelSegment(value: unknown) {
  const text = trimText(value);
  return text && !/\s/.test(text) ? text : undefined;
}

function normalizeProviderModel(
  provider: unknown,
  modelId: unknown,
): { provider: string; modelId: string } | undefined {
  const normalizedProvider = normalizeModelSegment(provider);
  const normalizedModelId = normalizeModelSegment(modelId);
  if (!normalizedProvider || !normalizedModelId) return undefined;
  return {
    provider: normalizedProvider,
    modelId: normalizedModelId,
  };
}

function formatModelRef(parts: { provider: string; modelId: string }) {
  return `${parts.provider}/${parts.modelId}`;
}

function uniqueSortedModelIds(ids: Iterable<unknown>) {
  return Array.from(
    new Set(
      Array.from(ids)
        .map((id) => normalizeModelSegment(id))
        .filter((id): id is string => Boolean(id)),
    ),
  ).sort(compareModelIds);
}

export function normalizeModelRef(value?: string): string | undefined {
  const parsed = splitModelRef(normalizeModelRefText(value));
  return parsed ? formatModelRef(parsed) : undefined;
}

export function splitModelRef(
  value: string,
): { provider: string; modelId: string } | undefined {
  const text = normalizeModelRefText(value);
  if (!text) return undefined;
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return undefined;
  return normalizeProviderModel(text.slice(0, slash), text.slice(slash + 1));
}

export function modelSortKey(id: string): string {
  const text = id.toLowerCase();
  const date = text.match(/(20\d{2})(\d{2})(\d{2})/);
  if (date) return `4-${date[0]}`;
  if (/\b(latest|preview|exp|experimental)\b/.test(text)) return `3-${text}`;
  const nums = [...text.matchAll(/\d+/g)]
    .map((m) => m[0].padStart(4, "0"))
    .join("-");
  if (nums) return `2-${nums}-${text}`;
  return `1-${text}`;
}

export function compareModelIds(a: string, b: string): number {
  const keyA = modelSortKey(a);
  const keyB = modelSortKey(b);
  if (keyA === keyB) return a.localeCompare(b);
  return keyB.localeCompare(keyA);
}

export async function getProviderSummaries(
  ctx: any,
): Promise<ProviderModelSummary[]> {
  const availableModels = await Promise.resolve(
    ctx.modelRegistry.getAvailable(),
  );
  const grouped = new Map<string, string[]>();

  for (const model of Array.isArray(availableModels) ? availableModels : []) {
    const parsed = normalizeProviderModel(model?.provider, model?.id);
    if (!parsed) continue;
    const list = grouped.get(parsed.provider) ?? [];
    list.push(parsed.modelId);
    grouped.set(parsed.provider, list);
  }

  return Array.from(grouped.entries())
    .map(([provider, ids]) => {
      const all = uniqueSortedModelIds(ids);
      return { provider, count: all.length, top3: all.slice(0, 3), all };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function buildModelLookup(
  providers: ProviderModelSummary[],
): Set<string> {
  const models = new Set<string>();
  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerName = normalizeModelSegment(provider?.provider);
    if (!providerName) continue;
    for (const modelId of uniqueSortedModelIds(
      Array.isArray(provider?.all) ? provider.all : [],
    )) {
      models.add(formatModelRef({ provider: providerName, modelId }));
    }
  }
  return models;
}
