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

function normalizeModelSegment(value: unknown) {
  const text = trimText(value);
  return text && !/\s/.test(text) ? text : undefined;
}

export function normalizeModelRef(value?: string): string | undefined {
  const text = trimText(value).replace(/^@/, "");
  const parsed = splitModelRef(text);
  return parsed ? `${parsed.provider}/${parsed.modelId}` : undefined;
}

export function splitModelRef(
  value: string,
): { provider: string; modelId: string } | undefined {
  const text = trimText(value).replace(/^@/, "");
  if (!text) return undefined;
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return undefined;
  const provider = normalizeModelSegment(text.slice(0, slash));
  const modelId = normalizeModelSegment(text.slice(slash + 1));
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
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
    const provider = normalizeModelSegment(model?.provider);
    const modelId = normalizeModelSegment(model?.id);
    if (!provider || !modelId) continue;
    const list = grouped.get(provider) ?? [];
    list.push(modelId);
    grouped.set(provider, list);
  }

  return Array.from(grouped.entries())
    .map(([provider, ids]) => {
      const all = [...new Set(ids)].sort(compareModelIds);
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
    for (const model of Array.isArray(provider?.all) ? provider.all : []) {
      const modelId = normalizeModelSegment(model);
      if (!modelId) continue;
      models.add(`${providerName}/${modelId}`);
    }
  }
  return models;
}
