import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getAgentDir, type ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import jiti from '@mariozechner/jiti'

type KoishiMessagePart = {
  type: 'text'
  text: string
} | {
  type: 'at'
  id: string
  name?: string
} | {
  type: 'image'
  path?: string
  url?: string
  mimeType?: string
} | {
  type: 'file'
  path?: string
  url?: string
  name?: string
  mimeType?: string
}

async function loadOutboxModule() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const distPath = path.join(root, 'dist', 'core', 'rin-lib', 'chat-outbox.js')
  if (fs.existsSync(distPath)) return await import(pathToFileURL(distPath).href)
  const sourcePath = path.join(root, 'src', 'core', 'rin-lib', 'chat-outbox.ts')
  const sourceLoader = jiti(import.meta.url, { interopDefault: true, moduleCache: true })
  return await sourceLoader.import(sourcePath)
}

const textPartSchema = Type.Object({
  type: Type.Literal('text'),
  text: Type.String({ description: 'Plain text to send.' }),
})

const atPartSchema = Type.Object({
  type: Type.Literal('at'),
  id: Type.String({ description: 'Platform user ID to mention.' }),
  name: Type.Optional(Type.String({ description: 'Optional display name hint.' })),
})

const imagePartSchema = Type.Object({
  type: Type.Literal('image'),
  path: Type.Optional(Type.String({ description: 'Absolute or relative local image path.' })),
  url: Type.Optional(Type.String({ description: 'Remote image URL.' })),
  mimeType: Type.Optional(Type.String({ description: 'Optional MIME type like image/png.' })),
})

const filePartSchema = Type.Object({
  type: Type.Literal('file'),
  path: Type.Optional(Type.String({ description: 'Absolute or relative local file path.' })),
  url: Type.Optional(Type.String({ description: 'Remote file URL.' })),
  name: Type.Optional(Type.String({ description: 'Optional file name override.' })),
  mimeType: Type.Optional(Type.String({ description: 'Optional MIME type.' })),
})

function safeString(value: unknown) {
  if (value == null) return ''
  return String(value)
}

function resolveMaybeLocalPath(input: string, cwd: string) {
  const value = input.trim()
  if (!value) return ''
  if (value === '~') return `${process.env.HOME || ''}`
  if (value.startsWith('~/')) return path.join(process.env.HOME || '', value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(cwd, value)
}

function normalizeParts(parts: any[], cwd: string): KoishiMessagePart[] {
  const normalized: KoishiMessagePart[] = []
  for (const raw of parts) {
    const type = safeString(raw?.type).trim()
    if (type === 'text') {
      const text = safeString(raw?.text)
      if (text) normalized.push({ type: 'text', text })
      continue
    }
    if (type === 'at') {
      const id = safeString(raw?.id).trim()
      if (!id) throw new Error('koishi_send_message_invalid_at_id')
      normalized.push({ type: 'at', id, name: safeString(raw?.name).trim() || undefined })
      continue
    }
    if (type === 'image' || type === 'file') {
      const localPath = safeString(raw?.path).trim() ? resolveMaybeLocalPath(safeString(raw?.path), cwd) : ''
      const url = safeString(raw?.url).trim()
      if (!localPath && !url) throw new Error(`koishi_send_message_${type}_requires_path_or_url`)
      if (localPath && !fs.existsSync(localPath)) throw new Error(`koishi_send_message_missing_file:${localPath}`)
      if (type === 'image') {
        normalized.push({
          type: 'image',
          path: localPath || undefined,
          url: url || undefined,
          mimeType: safeString(raw?.mimeType).trim() || undefined,
        })
      } else {
        normalized.push({
          type: 'file',
          path: localPath || undefined,
          url: url || undefined,
          name: safeString(raw?.name).trim() || undefined,
          mimeType: safeString(raw?.mimeType).trim() || undefined,
        })
      }
      continue
    }
    throw new Error(`koishi_send_message_unsupported_part:${type || 'unknown'}`)
  }
  return normalized
}

function isChatKey(value: string) {
  return /^[^/:]+(?:\/[^:]+)?:.+$/.test(value.trim())
}

export default function koishiSendMessageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'koishi_send_message',
    label: 'Koishi Send Message',
    description: 'Queue a message to a specific Koishi chatKey. Supports text, @ mentions, images, and files.',
    promptSnippet: 'Send a message to another Koishi chat when the user explicitly asks to notify or forward something there.',
    promptGuidelines: [
      'Use `koishi_send_message` only when the user explicitly wants to send or forward something into a specific Koishi chat.',
      'Do not use this tool just to reply in the current chat; normal assistant output already does that.',
      'Always require an explicit `chatKey`.',
      'Prefer structured `parts` for mixed content; `text` is just a convenience shortcut for simple plain-text messages.',
    ],
    parameters: Type.Object({
      chatKey: Type.String({ description: 'Target chat key like telegram/123456:987654321 or onebot:private:12345.' }),
      text: Type.Optional(Type.String({ description: 'Convenience plain-text message. Prepended before parts.' })),
      parts: Type.Optional(Type.Array(Type.Union([
        textPartSchema,
        atPartSchema,
        imagePartSchema,
        filePartSchema,
      ]), { description: 'Structured message parts for mixed content.' })),
      replyToMessageId: Type.Optional(Type.String({ description: 'Optional platform message ID to quote/reply to.' })),
    }),
    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      const chatKey = safeString((params as any)?.chatKey).trim()
      if (!isChatKey(chatKey)) throw new Error(`koishi_send_message_invalid_chatKey:${chatKey || 'missing'}`)

      const parts = normalizeParts([
        ...(safeString((params as any)?.text) ? [{ type: 'text', text: safeString((params as any).text) }] : []),
        ...(Array.isArray((params as any)?.parts) ? (params as any).parts : []),
      ], ctx.cwd)

      if (!parts.length) throw new Error('koishi_send_message_empty')

      const agentDir = getAgentDir()
      const requestId = safeString(toolCallId).trim() || `koishi_${Date.now().toString(36)}`
      const { enqueueChatOutboxPayload } = await loadOutboxModule()
      const filePath = enqueueChatOutboxPayload(agentDir, {
        type: 'parts_delivery',
        createdAt: new Date().toISOString(),
        requestId,
        chatKey,
        replyToMessageId: safeString((params as any)?.replyToMessageId).trim() || undefined,
        parts,
      })

      const summary = [
        `Queued Koishi message to ${chatKey}.`,
        `Parts: ${parts.map((part) => part.type).join(', ')}`,
        `Outbox: ${filePath}`,
      ].join('\n')

      return {
        content: [{ type: 'text', text: summary }],
        details: { chatKey, requestId, parts, outboxPath: filePath },
      }
    },
  })
}
