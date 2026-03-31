import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

type KoishiBridgePromptMeta = {
  source?: string
  sentAt?: number
  chatKey?: string
  chatName?: string
  userId?: string
  nickname?: string
  identity?: string
  replyToMessageId?: string
}

const KOISHI_BRIDGE_PROMPT_META_PREFIX = '[[rin-koishi-bridge-meta:'

function buildKoishiSystemPromptBlock(meta: KoishiBridgePromptMeta) {
  return [
    `- The current Koishi chatKey is: ${safeString(meta.chatKey).trim() || 'unknown'}`,
    `- The current chat name is: ${safeString(meta.chatName).trim() || 'unknown'}`,
    '- In Koishi bridge chats, sender fields describe the current incoming platform message sender, not the local OS user and not the agent itself.',
    '- `sender identity` uses the bridge trust classification: `OWNER` = configured owner, `TRUSTED` = trusted user, `OTHER` = unknown or untrusted user.',
    '- When replying in Koishi bridge chats, do not use Markdown. Reply in plain text only. Do not use headings, tables, fenced code blocks, emphasis markers, or Markdown link syntax.',
  ].join('\n')
}

function safeString(value: unknown) {
  if (value == null) return ''
  return String(value)
}

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function formatTimestamp(value: number) {
  const date = new Date(Number.isFinite(value) ? value : Date.now())
  const year = date.getFullYear()
  const month = pad2(date.getMonth() + 1)
  const day = pad2(date.getDate())
  const hour = pad2(date.getHours())
  const minute = pad2(date.getMinutes())
  const second = pad2(date.getSeconds())
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const offsetHours = pad2(Math.floor(Math.abs(offsetMinutes) / 60))
  const offsetRemainder = pad2(Math.abs(offsetMinutes) % 60)
  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${sign}${offsetHours}:${offsetRemainder}`
}

function decodeKoishiBridgeMeta(text: string) {
  const input = safeString(text)
  if (!input.startsWith(KOISHI_BRIDGE_PROMPT_META_PREFIX)) return { meta: null as KoishiBridgePromptMeta | null, body: input }
  const end = input.indexOf(']]')
  if (end < 0) return { meta: null as KoishiBridgePromptMeta | null, body: input }
  const encoded = input.slice(KOISHI_BRIDGE_PROMPT_META_PREFIX.length, end).trim()
  if (!encoded) return { meta: null as KoishiBridgePromptMeta | null, body: input }
  try {
    const meta = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as KoishiBridgePromptMeta
    const body = input.slice(end + 2).replace(/^\s*\n/, '')
    return { meta, body }
  } catch {
    return { meta: null as KoishiBridgePromptMeta | null, body: input }
  }
}

function buildHeader(body: string, meta: KoishiBridgePromptMeta | null, fallbackTimestamp: number) {
  const lines = [`sent at: ${formatTimestamp(Number(meta?.sentAt) || fallbackTimestamp)}`]
  if (meta?.source === 'koishi-bridge') {
    lines.push(`chatKey: ${safeString(meta.chatKey).trim() || 'unknown'}`)
    lines.push(`chat name: ${safeString(meta.chatName).trim() || 'unknown'}`)
    lines.push(`sender user id: ${safeString(meta.userId).trim() || 'unknown'}`)
    lines.push(`sender nickname: ${safeString(meta.nickname).trim() || 'unknown'}`)
    lines.push(`sender identity: ${safeString(meta.identity).trim() || 'OTHER'}`)
    if (safeString(meta.replyToMessageId).trim()) lines.push(`reply to message id: ${safeString(meta.replyToMessageId).trim()}`)
  }
  return `${lines.join('\n')}\n---\n${body}`
}

export default function messageHeaderExtension(pi: ExtensionAPI) {
  const pendingContexts: Array<{ meta: KoishiBridgePromptMeta | null; body: string; sentAt: number }> = []

  pi.on('input', async (event) => {
    if (event.source === 'extension') return { action: 'continue' }

    const originalText = safeString(event.text)
    const { meta, body } = decodeKoishiBridgeMeta(originalText)
    pendingContexts.push({
      meta: meta?.source === 'koishi-bridge' ? meta : null,
      body,
      sentAt: Number(meta?.sentAt) || Date.now(),
    })
    return { action: 'continue' }
  })

  pi.on('before_agent_start', async (event) => {
    const current = pendingContexts.shift() || { meta: null, body: safeString(event.prompt), sentAt: Date.now() }
    const result: { systemPrompt?: string; message?: { customType: string; content: string; display: boolean } } = {
      message: {
        customType: 'message-header-context',
        content: buildHeader(current.body, current.meta, current.sentAt),
        display: false,
      },
    }

    if (current.meta?.source === 'koishi-bridge') {
      const block = buildKoishiSystemPromptBlock(current.meta)
      if (!safeString(event.systemPrompt).includes(block)) {
        result.systemPrompt = `${safeString(event.systemPrompt).trimEnd()}\n\n${block}`.trimEnd()
      }
    }

    return result
  })
}
