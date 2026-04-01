import type { ThinkingLevel } from '@mariozechner/pi-agent-core'

export const VALID_SUBAGENT_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const satisfies ThinkingLevel[]

export function normalizeModelRef(value?: string): string | undefined {
  const text = String(value || '').trim()
  if (!text) return undefined
  return text.replace(/^@/, '')
}

export function splitModelRef(value: string): { provider: string; modelId: string } | undefined {
  const text = normalizeModelRef(value)
  if (!text) return undefined
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) return undefined
  return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) }
}

export function modelSortKey(id: string): string {
  const text = id.toLowerCase()
  const date = text.match(/(20\d{2})(\d{2})(\d{2})/)
  if (date) return `4-${date[0]}`
  if (/\b(latest|preview|exp|experimental)\b/.test(text)) return `3-${text}`
  const nums = [...text.matchAll(/\d+/g)].map((m) => m[0].padStart(4, '0')).join('-')
  if (nums) return `2-${nums}-${text}`
  return `1-${text}`
}

export function compareModelIds(a: string, b: string): number {
  const keyA = modelSortKey(a)
  const keyB = modelSortKey(b)
  if (keyA === keyB) return a.localeCompare(b)
  return keyB.localeCompare(keyA)
}

export type ProviderModelSummary = {
  provider: string
  count: number
  top3: string[]
  all: string[]
}

export async function getProviderSummaries(ctx: any): Promise<ProviderModelSummary[]> {
  const availableModels = await Promise.resolve(ctx.modelRegistry.getAvailable())
  const grouped = new Map<string, string[]>()

  for (const model of availableModels) {
    const list = grouped.get(model.provider) ?? []
    list.push(model.id)
    grouped.set(model.provider, list)
  }

  return Array.from(grouped.entries())
    .map(([provider, ids]) => {
      const all = [...new Set(ids)].sort(compareModelIds)
      return { provider, count: all.length, top3: all.slice(0, 3), all }
    })
    .sort((a, b) => a.provider.localeCompare(b.provider))
}

export function buildModelLookup(providers: ProviderModelSummary[]): Set<string> {
  const models = new Set<string>()
  for (const provider of providers) {
    for (const model of provider.all) models.add(`${provider.provider}/${model}`)
  }
  return models
}
