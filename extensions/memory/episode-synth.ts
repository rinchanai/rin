import { complete, type Model } from '@mariozechner/pi-ai'

import { executeMemoryTool } from './lib.js'

type ExtensionCtxLike = {
  model?: Model<any> | null
  modelRegistry?: {
    getApiKeyAndHeaders?: (model: Model<any>) => Promise<{ ok: boolean, apiKey?: string, headers?: Record<string, string>, error?: string }>
  }
  signal?: AbortSignal
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : String(value || '')
}

function slugify(value: string, fallback = 'memory'): string {
  const raw = safeString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return raw || fallback
}

function hashText(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => safeString(part?.text))
    .join('\n')
    .trim()
}

function turnTranscript(messages: any[]): string {
  return messages
    .map((message) => {
      const role = safeString(message?.role || message?.message?.role || 'unknown').trim() || 'unknown'
      const content = stringifyContent(message?.content ?? message?.message?.content)
      if (!content) return ''
      return `${role.toUpperCase()}: ${content}`
    })
    .filter(Boolean)
    .join('\n\n')
}

function sessionKey(sessionFile = '', sessionId = ''): string {
  const fromFile = safeString(sessionFile).trim().split('/').pop()?.replace(/\.[^.]+$/, '') || ''
  if (fromFile) return slugify(fromFile, 'session')
  return slugify(sessionId, 'session')
}

function extractJson(text: string): any {
  const raw = safeString(text).trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced) {
    try { return JSON.parse(fenced[1]) } catch {}
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch {}
  }
  return null
}

const EPISODE_SYSTEM_PROMPT = `You synthesize a compact structured episode update for long-term memory.
Return JSON only.
Schema:
{
  "summary": string,
  "preferences": string[],
  "decisions": string[],
  "openThreads": string[],
  "tags": string[],
  "triggers": string[]
}
Rules:
- Focus only on durable takeaways from this turn.
- Prefer empty arrays over weak guesses.
- Keep each bullet short and explicit.
- Do not include markdown fences or extra prose.`

function section(title: string, items: string[]): string[] {
  if (!items.length) return []
  return ['', `### ${title}`, ...items.map((item) => `- ${item}`)]
}

export async function synthesizeEpisodeTurn(ctx: ExtensionCtxLike, messages: any[], opts: { sessionFile?: string, sessionId?: string } = {}) {
  const model = ctx.model
  if (!model || !ctx.modelRegistry?.getApiKeyAndHeaders) return { skipped: 'no-model' }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  if (!auth.ok || !auth.apiKey) return { skipped: auth.ok ? 'no-api-key' : safeString(auth.error || 'auth-failed') }

  const transcript = turnTranscript(messages)
  if (!transcript) return { skipped: 'empty-transcript' }

  const response = await complete(
    model,
    {
      systemPrompt: EPISODE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }], timestamp: Date.now() }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
      reasoningEffort: 'medium',
    },
  )

  const text = response.content
    .filter((part): part is { type: 'text', text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  const parsed = extractJson(text) || {}
  const summary = safeString(parsed.summary || '').trim()
  const preferences = Array.isArray(parsed.preferences) ? parsed.preferences.map((v: any) => safeString(v).trim()).filter(Boolean) : []
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions.map((v: any) => safeString(v).trim()).filter(Boolean) : []
  const openThreads = Array.isArray(parsed.openThreads) ? parsed.openThreads.map((v: any) => safeString(v).trim()).filter(Boolean) : []
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map((v: any) => safeString(v).trim()).filter(Boolean) : []
  const triggers = Array.isArray(parsed.triggers) ? parsed.triggers.map((v: any) => safeString(v).trim()).filter(Boolean) : []

  const date = new Date().toISOString().slice(0, 10)
  const session = sessionKey(opts.sessionFile, opts.sessionId)
  const id = `${date}-${session}-episode`
  const marker = `<!-- turn:${hashText(transcript)} -->`
  const title = `${date} ${session} episode`
  let existingContent = ''
  let existingSummary = ''
  let existingTags: string[] = []
  let existingTriggers: string[] = []

  try {
    const existing = await executeMemoryTool({ action: 'get', id })
    existingContent = safeString(existing?.content || '')
    existingSummary = safeString(existing?.summary || '')
    existingTags = Array.isArray(existing?.tags) ? existing.tags.map((v: any) => safeString(v).trim()).filter(Boolean) : []
    existingTriggers = Array.isArray(existing?.triggers) ? existing.triggers.map((v: any) => safeString(v).trim()).filter(Boolean) : []
    if (existingContent.includes(marker)) return { skipped: 'already-summarized' }
  } catch {}

  const timestamp = new Date().toISOString().slice(11, 16)
  const block = [
    marker,
    `## Turn ${timestamp}`,
    summary ? `- ${summary}` : '- Episode update recorded.',
    ...section('Preferences', preferences),
    ...section('Decisions', decisions),
    ...section('Open threads', openThreads),
    '',
    '### Transcript',
    '```text',
    transcript,
    '```',
  ].join('\n')

  const content = [existingContent.trim(), block].filter(Boolean).join('\n\n')
  const mergedTags = Array.from(new Set(['episode', session, ...existingTags, ...tags].filter(Boolean)))
  const mergedTriggers = Array.from(new Set(['episode', 'summary', ...existingTriggers, ...triggers].filter(Boolean)))

  await executeMemoryTool({
    action: 'save',
    id,
    title,
    content,
    summary: summary || existingSummary || `Episode memory for ${session} on ${date}.`,
    exposure: 'recall',
    scope: 'session',
    kind: 'history',
    tags: mergedTags,
    triggers: mergedTriggers,
    source: 'extension:episode_synth',
  })

  return { skipped: '', saved: true, id }
}
