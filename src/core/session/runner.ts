import { safeString } from '../platform/process.js'

import { openBoundSession } from './factory.js'

export async function runSessionPrompt(options: {
  cwd: string
  agentDir: string
  prompt: string
  additionalExtensionPaths?: string[]
  sessionFile?: string
}) {
  const { session } = await openBoundSession(options)
  try {
    await session.prompt(options.prompt, {
      expandPromptTemplates: false,
      source: 'rpc' as any,
    })
    await session.agent.waitForIdle()
    const sessionFile = safeString(session.sessionFile || session.sessionManager?.getSessionFile?.() || '').trim() || undefined
    const finalText = safeString(session.getLastAssistantText?.() || '').trim()
    return { session, sessionFile, finalText }
  } finally {
    try { await session.abort() } catch {}
  }
}
