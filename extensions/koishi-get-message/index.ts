import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getAgentDir, type ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

async function loadMessageStoreModule() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const distPath = path.join(root, 'dist', 'core', 'rin-koishi', 'message-store.js')
  return await import(pathToFileURL(distPath).href)
}

function safeString(value: unknown) {
  if (value == null) return ''
  return String(value)
}

export default function koishiGetMessageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'koishi_get_message',
    label: 'Koishi Get Message',
    description: 'Look up stored inbound Koishi messages by platform message ID, including reply target and recorded agent session linkage.',
    promptSnippet: 'Look up stored Koishi inbound messages by message ID when you need the original message body, reply chain, or linked session id.',
    parameters: Type.Object({
      messageId: Type.String({ description: 'Platform message ID to look up.' }),
      chatKey: Type.Optional(Type.String({ description: 'Optional chat key to disambiguate duplicated platform message IDs.' })),
    }),
    execute: async (_toolCallId, params) => {
      const messageId = safeString((params as any)?.messageId).trim()
      const chatKey = safeString((params as any)?.chatKey).trim() || undefined
      if (!messageId) throw new Error('koishi_get_message_messageId_required')

      const agentDir = getAgentDir()
      const { normalizeKoishiMessageLookup, describeKoishiMessageRecord, summarizeKoishiMessageRecord } = await loadMessageStoreModule()
      const matches = normalizeKoishiMessageLookup(agentDir, messageId, chatKey)
      const agentText = matches.length
        ? ['koishi_get_message', ...matches.map((item: any, index: number) => `match ${index + 1}\n${describeKoishiMessageRecord(item)}`)].join('\n\n')
        : `koishi_get_message\nnot_found messageId=${messageId}${chatKey ? `\nchatKey=${chatKey}` : ''}`
      const userText = matches.length
        ? ['找到这些消息：', ...matches.map((item: any, index: number) => `${index + 1}.\n${summarizeKoishiMessageRecord(item)}`)].join('\n\n')
        : `未找到消息：${messageId}${chatKey ? `（chatKey=${chatKey}）` : ''}`

      return {
        content: [{ type: 'text', text: agentText }],
        details: { messageId, chatKey, matches, agentText, userText },
        isError: !matches.length,
      }
    },
    renderResult(result) {
      const details = result.details as any
      const fallback = result.content?.[0]?.type === 'text' ? result.content[0].text : '(no output)'
      return new Text(String(details?.userText || fallback), 0, 0)
    },
  })
}
