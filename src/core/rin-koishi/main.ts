#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, pathToFileURL as toFileUrl } from 'node:url'

import type { ImageContent } from '@mariozechner/pi-ai'

import { RinDaemonFrontendClient } from '../rin-tui/rpc-client.js'
import { RpcInteractiveSession } from '../rin-tui/runtime.js'
import { applyRuntimeProfileEnvironment, resolveRuntimeProfile } from '../rin-lib/runtime.js'
import {
  canAccessAgentInput,
  canRunCommand,
  chatStateDir,
  chatStatePath,
  composeChatKey,
  ensureExtension,
  ensureFileName,
  fileNameFromUrl,
  findBot,
  listChatStateFiles,
  loadIdentity,
  materializeKoishiConfig,
  parseChatKey,
  readJsonFile,
  trustOf,
  writeJsonFile,
} from './support.js'

const require = createRequire(import.meta.url)
const { Loader, Logger, h } = require('koishi') as { Loader: any; Logger: any; h: any }

const logger = new Logger('rin-koishi')
const INTERIM_PREFIX = '··· '
const TYPING_INTERVAL_MS = 4000
const INTERIM_MIN_INTERVAL_MS = 1500
const RIN_KOISHI_SETTINGS_PATH_ENV = 'RIN_KOISHI_SETTINGS_PATH'

type SavedAttachment = {
  kind: 'image' | 'file'
  path: string
  name: string
  mimeType?: string
}

type KoishiChatState = {
  chatKey: string
  piSessionFile?: string
  processing?: {
    text: string
    attachments: SavedAttachment[]
    startedAt: number
    replyToMessageId?: string
  }
}

function safeString(value: unknown) {
  if (value == null) return ''
  return String(value)
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function pickUserId(session: any) {
  return safeString(session?.userId || session?.author?.userId || '').trim()
}

function directLike(session: any) {
  return Boolean(session?.isDirect) || !safeString(session?.guildId || '').trim() || safeString(session?.channelId || '').startsWith('private:')
}

async function isPrivateLikeGroupSession(session: any, trust: string) {
  if (!session?.guildId || trust !== 'OWNER') return false
  const platform = safeString(session?.platform || '').trim()
  const chatId = getChatId(session)
  if (!platform || !chatId) return false
  const bot = session?.bot

  try {
    if (platform === 'telegram' && bot?.internal && typeof bot.internal.getChatMemberCount === 'function') {
      const count = Number(await bot.internal.getChatMemberCount({ chat_id: chatId }))
      return Number.isFinite(count) && count > 0 && count <= 2
    }
    if (platform === 'onebot' && bot?.internal && typeof bot.internal.getGroupInfo === 'function') {
      const info = await bot.internal.getGroupInfo(chatId, true)
      const count = Number(info?.member_count ?? info?.memberCount ?? 0)
      return Number.isFinite(count) && count > 0 && count <= 2
    }
  } catch {}

  return false
}

function mentionLike(session: any) {
  return Boolean(session?.stripped?.appel)
}

function getIncomingText(session: any) {
  return safeString(session?.stripped?.content || session?.content || '').trim()
}

function getChatId(session: any) {
  const channelId = safeString(session?.channelId || '').trim()
  if (channelId) return channelId
  const userId = pickUserId(session)
  if (!userId) return ''
  return safeString(session?.platform) === 'onebot' ? `private:${userId}` : userId
}

function getChatType(session: any): 'private' | 'group' {
  return directLike(session) ? 'private' : 'group'
}

function isCommandText(text: string) {
  return /^\/[A-Za-z0-9_:-]+(?:\s|$)/.test(text)
}

function commandNameFromText(text: string) {
  const match = text.trim().match(/^\/([^\s]+)/)
  return match ? match[1] : ''
}

function extractTextFromContent(content: any, { includeThinking = false }: { includeThinking?: boolean } = {}) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      if (part.type === 'text') return safeString(part.text)
      if (includeThinking && part.type === 'thinking') return safeString(part.thinking)
      return ''
    })
    .filter(Boolean)
    .join('')
    .trim()
}

function extractImageParts(content: any) {
  if (!Array.isArray(content)) return [] as Array<{ data: string; mimeType: string }>
  const out: Array<{ data: string; mimeType: string }> = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type !== 'image') continue
    const data = safeString((part as any).data || '')
    const mimeType = safeString((part as any).mimeType || '').trim() || 'image/png'
    if (!data) continue
    out.push({ data, mimeType })
  }
  return out
}

function extractExistingFilePaths(text: string) {
  const out: string[] = []
  const seen = new Set<string>()
  const patterns = [
    /(?:file:\/\/)?(\/[^\s'"`<>]+)/g,
    /(~\/[^\s'"`<>]+)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = safeString(match[1] || '').trim()
      if (!raw) continue
      const expanded = raw.startsWith('~/') ? path.join(process.env.HOME || '', raw.slice(2)) : raw
      const resolved = path.resolve(expanded)
      if (seen.has(resolved)) continue
      if (!fs.existsSync(resolved)) continue
      if (!fs.statSync(resolved).isFile()) continue
      seen.add(resolved)
      out.push(resolved)
    }
  }
  return out.slice(0, 8)
}

async function sendTyping(app: any, chatKey: string) {
  const parsed = parseChatKey(chatKey)
  if (!parsed || parsed.platform !== 'telegram') return
  const bot = findBot(app, parsed.platform, parsed.botId)
  if (!bot?.internal?.sendChatAction) return
  try {
    await bot.internal.sendChatAction({ chat_id: parsed.chatId, action: 'typing' })
  } catch {}
}

async function sendText(app: any, chatKey: string, text: string, replyToMessageId = '') {
  const parsed = parseChatKey(chatKey)
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`)
  const bot = findBot(app, parsed.platform, parsed.botId)
  if (!bot) throw new Error(`no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ''}`)
  const content = replyToMessageId ? [h.quote(replyToMessageId), text] : text
  await bot.sendMessage(parsed.chatId, content)
}

async function sendImageFile(app: any, chatKey: string, filePath: string, mimeType = 'image/png', replyToMessageId = '') {
  const parsed = parseChatKey(chatKey)
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`)
  const bot = findBot(app, parsed.platform, parsed.botId)
  if (!bot) throw new Error(`no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ''}`)
  const buffer = await fs.promises.readFile(filePath)
  const content = replyToMessageId ? [h.quote(replyToMessageId), h.image(buffer, mimeType)] : [h.image(buffer, mimeType)]
  await bot.sendMessage(parsed.chatId, content)
}

async function sendGenericFile(app: any, chatKey: string, filePath: string, name?: string, replyToMessageId = '') {
  const parsed = parseChatKey(chatKey)
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`)
  const bot = findBot(app, parsed.platform, parsed.botId)
  if (!bot) throw new Error(`no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ''}`)
  const fileNode = h('file', { src: toFileUrl(filePath).href, name: name || path.basename(filePath) })
  const content = replyToMessageId ? [h.quote(replyToMessageId), fileNode] : [fileNode]
  await bot.sendMessage(parsed.chatId, content)
}

function buildPromptText(text: string, attachments: SavedAttachment[]) {
  const files = attachments.filter((item) => item.kind === 'file')
  if (!files.length) return text
  const lines = files.map((item) => `- ${item.name}: ${item.path}`)
  return `${text}\n\nAttached files saved locally:\n${lines.join('\n')}`
}

async function attachmentToImageContent(filePath: string, mimeType = 'image/png'): Promise<ImageContent> {
  const data = await fs.promises.readFile(filePath)
  return { type: 'image', data: data.toString('base64'), mimeType }
}

async function restorePromptParts(processing: NonNullable<KoishiChatState['processing']>) {
  const attachments = (processing.attachments || []).filter((item) => item && fs.existsSync(item.path))
  const images = await Promise.all(
    attachments
      .filter((item) => item.kind === 'image')
      .map((item) => attachmentToImageContent(item.path, item.mimeType || 'image/png')),
  )
  const text = buildPromptText(processing.text, attachments)
  return { text, images, attachments }
}

async function persistImageParts(chatDir: string, images: Array<{ data: string; mimeType: string }>, prefix: string) {
  const dir = path.join(chatDir, 'outbound')
  ensureDir(dir)
  const out: SavedAttachment[] = []
  let index = 0
  for (const image of images) {
    index += 1
    const fileName = ensureExtension(`${prefix}-${index}`, image.mimeType)
    const filePath = path.join(dir, fileName)
    await fs.promises.writeFile(filePath, Buffer.from(image.data, 'base64'))
    out.push({ kind: 'image', path: filePath, name: fileName, mimeType: image.mimeType })
  }
  return out
}

async function extractInboundAttachments(session: any, chatDir: string) {
  const dir = path.join(chatDir, 'inbound')
  ensureDir(dir)
  const attachments: SavedAttachment[] = []
  const elements = Array.isArray(session?.elements) ? session.elements : []
  let index = 0

  for (const element of elements) {
    const type = safeString(element?.type || '').toLowerCase()
    const attrs = element?.attrs && typeof element.attrs === 'object' ? element.attrs : {}
    const src = safeString(attrs.src || attrs.url || attrs.file || '').trim()
    if (!src) continue

    const kind = type === 'img' || type === 'image' ? 'image' : type === 'file' ? 'file' : ''
    if (!kind) continue

    index += 1
    const response = await fetch(src)
    if (!response.ok) continue
    const arrayBuffer = await response.arrayBuffer()
    const mimeType = safeString(response.headers.get('content-type') || attrs.mime || '').split(';', 1)[0].trim()
    const rawName = safeString(attrs.file || attrs.title || attrs.name || fileNameFromUrl(src, `${kind}-${index}`)).trim() || `${kind}-${index}`
    const fileName = ensureExtension(ensureFileName(rawName, `${kind}-${index}`), mimeType)
    const filePath = path.join(dir, `${Date.now()}-${index}-${fileName}`)
    await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer))
    attachments.push({ kind: kind as 'image' | 'file', path: filePath, name: fileName, mimeType })
  }

  return attachments
}

class KoishiChatController {
  app: any
  chatKey: string
  dataDir: string
  statePath: string
  state: KoishiChatState
  client: RinDaemonFrontendClient | null = null
  session: RpcInteractiveSession | null = null
  turnSeq = 0
  activeTag = ''
  turnWaiters = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  interimText = ''
  interimSentText = ''
  interimSentAt = 0
  typingTimer: NodeJS.Timeout | null = null
  latestAssistantText = ''
  pendingCompletedAssistantText = ''
  pendingOutboundImages: SavedAttachment[] = []
  pendingOutboundFiles: SavedAttachment[] = []
  pendingOutboundTasks: Promise<void>[] = []

  constructor(app: any, dataDir: string, chatKey: string) {
    this.app = app
    this.chatKey = chatKey
    this.dataDir = dataDir
    this.statePath = chatStatePath(dataDir, chatKey)
    this.state = readJsonFile<KoishiChatState>(this.statePath, { chatKey })
    if (!this.state.chatKey) this.state.chatKey = chatKey
  }

  async connect() {
    if (this.session && this.client) return
    const client = new RinDaemonFrontendClient()
    const session = new RpcInteractiveSession(client)
    await session.connect()
    this.client = client
    this.session = session

    client.subscribe((event) => {
      if (event.type !== 'ui') return
      const payload: any = event.payload
      if (payload?.type !== 'rpc_turn_event') return
      const requestTag = safeString(payload.requestTag || '').trim()
      const waiter = this.turnWaiters.get(requestTag)
      if (!waiter) return
      if (payload.event === 'complete') {
        this.turnWaiters.delete(requestTag)
        waiter.resolve(payload)
      } else if (payload.event === 'error') {
        this.turnWaiters.delete(requestTag)
        waiter.reject(new Error(String(payload.error || 'rpc_turn_failed')))
      }
    })

    session.subscribe((event: any) => {
      switch (event?.type) {
        case 'agent_start':
          this.interimText = ''
          this.interimSentText = ''
          this.pendingCompletedAssistantText = ''
          this.pendingOutboundImages = []
          this.pendingOutboundFiles = []
          this.latestAssistantText = ''
          this.startTyping()
          break
        case 'message_update':
          if (event?.message?.role !== 'assistant') break
          {
            const nextText = extractTextFromContent(event.message.content)
            if (nextText) {
              this.interimText = nextText
              this.latestAssistantText = nextText || this.latestAssistantText
            }
          }
          break
        case 'message_end': {
          if (event?.message?.role !== 'assistant') break
          const finalText = extractTextFromContent(event.message.content)
          if (finalText) {
            this.latestAssistantText = finalText
            this.pendingCompletedAssistantText = finalText
          }
          this.pendingOutboundTasks.push(
            persistImageParts(chatStateDir(this.dataDir, this.chatKey), extractImageParts(event.message.content), `${Date.now()}-assistant`)
              .then((images) => { this.pendingOutboundImages.push(...images) })
              .catch(() => {}),
          )
          for (const filePath of extractExistingFilePaths(finalText)) {
            this.pendingOutboundFiles.push({ kind: 'file', path: filePath, name: path.basename(filePath) })
          }
          break
        }
        case 'tool_execution_start':
        case 'tool_execution_end':
        case 'compaction_start':
        case 'compaction_end':
          if (this.pendingCompletedAssistantText) {
            void this.flushInterim().catch(() => {})
          }
          break
        case 'agent_end':
          this.pendingCompletedAssistantText = ''
          this.stopTyping()
          break
      }
    })

    const wantedSessionFile = safeString(this.state.piSessionFile || '').trim()
    if (wantedSessionFile) {
      await session.switchSession(wantedSessionFile).catch(() => {})
    }
    if (!session.sessionManager.getSessionName?.()) {
      await session.setSessionName(this.chatKey)
    }
  }

  dispose() {
    this.stopTyping()
    for (const waiter of this.turnWaiters.values()) waiter.reject(new Error('koishi_controller_disposed'))
    this.turnWaiters.clear()
    void this.session?.disconnect().catch(() => {})
    this.client = null
    this.session = null
  }

  private saveState() {
    writeJsonFile(this.statePath, this.state)
  }

  private startTyping() {
    this.stopTyping()
    void sendTyping(this.app, this.chatKey)
    this.typingTimer = setInterval(() => { void sendTyping(this.app, this.chatKey) }, TYPING_INTERVAL_MS)
  }

  private stopTyping() {
    if (!this.typingTimer) return
    clearInterval(this.typingTimer)
    this.typingTimer = null
  }

  private async flushInterim(force = false) {
    const text = safeString(this.pendingCompletedAssistantText || '').trim()
    if (!text) return
    const now = Date.now()
    if (!force && text === this.interimSentText) return
    if (!force && now - this.interimSentAt < INTERIM_MIN_INTERVAL_MS) return
    this.pendingCompletedAssistantText = ''
    this.interimSentText = text
    this.interimSentAt = now
    const replyToMessageId = safeString(this.state.processing?.replyToMessageId || '').trim()
    await sendText(this.app, this.chatKey, `${INTERIM_PREFIX}${text}`, replyToMessageId).catch(() => {})
  }

  private nextRequestTag() {
    this.turnSeq += 1
    return `${this.chatKey}:${Date.now()}:${this.turnSeq}`
  }

  private waitForTurn(tag: string) {
    return new Promise<any>((resolve, reject) => {
      this.turnWaiters.set(tag, { resolve, reject })
    })
  }

  async runCommand(commandLine: string, replyToMessageId = '') {
    await this.connect()
    if (!this.client || !this.session) throw new Error('koishi_session_not_connected')
    const response: any = await this.client.send({ type: 'run_command', commandLine })
    if (!response || response.success !== true) {
      throw new Error(String(response?.error || 'rin_run_command_failed'))
    }
    const data = response.data || {}
    this.state.piSessionFile = safeString(this.session.sessionManager.getSessionFile?.() || this.state.piSessionFile || '').trim() || undefined
    if (!this.session.sessionManager.getSessionName?.()) {
      await this.session.setSessionName(this.chatKey)
    }
    delete this.state.processing
    this.saveState()
    const text = safeString(data?.text || '').trim()
    if (text) await sendText(this.app, this.chatKey, text, replyToMessageId)
    return data
  }

  async runTurn(input: { text: string; attachments: SavedAttachment[]; replyToMessageId?: string }, mode: 'prompt' | 'interrupt_prompt' = 'prompt') {
    await this.connect()
    if (!this.client || !this.session) throw new Error('koishi_session_not_connected')

    const { text, images, attachments } = await restorePromptParts({
      text: input.text,
      attachments: input.attachments,
      startedAt: Date.now(),
    })
    const tag = this.nextRequestTag()
    this.activeTag = tag
    this.state.chatKey = this.chatKey
    this.state.piSessionFile = safeString(this.session.sessionManager.getSessionFile?.() || this.state.piSessionFile || '').trim() || undefined
    this.state.processing = { text: input.text, attachments, startedAt: Date.now(), replyToMessageId: safeString(input.replyToMessageId || '').trim() || undefined }
    this.saveState()

    const completion = this.waitForTurn(tag)
    this.startTyping()
    await this.client.send({ type: mode, message: text, images, requestTag: tag })
    const payload = await completion
    if (this.activeTag !== tag) return

    const replyToMessageId = safeString(this.state.processing?.replyToMessageId || input.replyToMessageId || '').trim()
    this.state.piSessionFile = safeString(payload?.sessionFile || this.session.sessionManager.getSessionFile?.() || this.state.piSessionFile || '').trim() || undefined
    delete this.state.processing
    this.saveState()

    await Promise.all(this.pendingOutboundTasks.splice(0))
    const finalText = safeString(this.latestAssistantText || '').trim()
    if (finalText) await sendText(this.app, this.chatKey, finalText, replyToMessageId)
    for (const image of this.pendingOutboundImages.splice(0)) {
      await sendImageFile(this.app, this.chatKey, image.path, image.mimeType || 'image/png', replyToMessageId).catch(() => {})
    }
    for (const file of this.pendingOutboundFiles.splice(0)) {
      await sendGenericFile(this.app, this.chatKey, file.path, file.name, replyToMessageId).catch(() => {})
    }
  }

  async recoverIfNeeded() {
    if (!this.state.processing) return
    await this.connect()
    if (!this.session) return
    const currentLastUser = [...(this.session.messages || [])].reverse().find((message: any) => message?.role === 'user')
    const lastUserText = extractTextFromContent(currentLastUser?.content)
    const pending = this.state.processing
    const recovered = safeString(lastUserText).trim() === safeString(buildPromptText(pending.text, pending.attachments)).trim()
      ? 'Please continue answering the previous user message. Your previous response was interrupted by a daemon restart. Continue directly without restarting from the beginning unless necessary.'
      : pending.text
    logger.info(`resume interrupted koishi turn chatKey=${this.chatKey}`)
    await this.runTurn({ text: recovered, attachments: pending.attachments, replyToMessageId: pending.replyToMessageId }, 'interrupt_prompt')
  }
}

function loadSettings(settingsPath: string) {
  const settings: any = readJsonFile(settingsPath, {}) || {}
  if (settings.enableSkillCommands == null) settings.enableSkillCommands = true
  return settings
}

async function shouldProcessText(session: any, identity: any, registeredCommands: Set<string>) {
  const text = getIncomingText(session)
  if (!text) return { allow: false, text: '', chatKey: '', trust: 'OTHER', commandName: '' }
  const platform = safeString(session?.platform || '').trim()
  const botId = safeString(session?.selfId || session?.bot?.selfId || '').trim()
  const chatId = getChatId(session)
  const chatKey = composeChatKey(platform, chatId, botId)
  const trust = trustOf(identity, platform, pickUserId(session))
  const commandName = commandNameFromText(text)
  const commandLike = isCommandText(text)
  const privateLike = directLike(session) || await isPrivateLikeGroupSession(session, trust)
  const allow = commandLike
    ? commandName ? canRunCommand(trust, commandName) : false
    : canAccessAgentInput({ chatType: privateLike ? 'private' : 'group', trust, mentionLike: mentionLike(session), commandLike: false })

  if (commandLike && (registeredCommands.has(commandName) || commandName === 'help')) {
    return { allow: false, text, chatKey, trust, commandName, registered: true }
  }

  return { allow, text, chatKey, trust, commandName, registered: false }
}

async function discoverRpcCommands() {
  const client = new RinDaemonFrontendClient()
  await client.connect()
  try {
    const commands = await client.getCommands()
    return commands.map((item) => ({ name: safeString(item.name).replace(/^\//, ''), description: safeString(item.description || '').trim() }))
      .filter((item) => item.name)
  } finally {
    await client.disconnect().catch(() => {})
  }
}

export async function startKoishi(options: { additionalExtensionPaths?: string[] } = {}) {
  const runtime = resolveRuntimeProfile()
  const dataDir = path.join(runtime.agentDir, 'data')
  const settingsPath = process.env[RIN_KOISHI_SETTINGS_PATH_ENV]?.trim() || path.join(runtime.agentDir, 'settings.json')
  const configPath = path.join(dataDir, 'koishi.yml')

  applyRuntimeProfileEnvironment(runtime)
  if (process.cwd() !== runtime.cwd) process.chdir(runtime.cwd)
  ensureDir(dataDir)

  const settings = loadSettings(settingsPath)
  materializeKoishiConfig(configPath, settings)

  const loader = new Loader()
  const previousCwd = process.cwd()
  if (previousCwd !== dataDir) process.chdir(dataDir)
  try {
    await loader.init(configPath)
    loader.envFiles = []
    await loader.readConfig(true)
  } finally {
    if (process.cwd() !== previousCwd) process.chdir(previousCwd)
  }

  const app = await loader.createApp()
  const controllers = new Map<string, KoishiChatController>()
  const registeredCommandNames = new Set<string>()
  const rpcCommands = await discoverRpcCommands()
  const allowedCommandNames = new Set(['new', 'compact', 'reload', 'session', 'resume', 'model'])
  const commandRows = [
    { name: 'help', description: 'Show available commands' },
    ...rpcCommands.filter((item) => allowedCommandNames.has(item.name)),
  ]
  const getIdentity = () => loadIdentity(dataDir)

  const getController = (chatKey: string) => {
    let controller = controllers.get(chatKey)
    if (!controller) {
      controller = new KoishiChatController(app, dataDir, chatKey)
      controllers.set(chatKey, controller)
    }
    return controller
  }

  for (const item of commandRows) {
    registeredCommandNames.add(item.name)
    app.command(`${item.name} [args:text]`, item.description || '', { slash: true })
      .action(async ({ session }: any, argsText: any) => {
        const platform = safeString(session?.platform || '').trim()
        const trust = trustOf(getIdentity(), platform, pickUserId(session))
        if (item.name !== 'help' && !canRunCommand(trust, item.name)) return ''
        try { session.__rinKoishiCommandHandled = true } catch {}
        const chatKey = composeChatKey(platform, getChatId(session), safeString(session?.selfId || session?.bot?.selfId || '').trim())
        if (!chatKey) return ''

        if (item.name === 'help') {
          const lines = commandRows.map((entry) => `/${entry.name}${entry.description ? ` — ${entry.description}` : ''}`)
          await sendText(app, chatKey, lines.join('\n'), safeString(session?.messageId || '').trim()).catch(() => {})
          return ''
        }

        const text = `/${item.name}${safeString(argsText).trim() ? ` ${safeString(argsText).trim()}` : ''}`
        void getController(chatKey).runCommand(text, safeString(session?.messageId || '').trim()).catch((error) => {
          logger.warn(`koishi command failed chatKey=${chatKey} command=${item.name} err=${safeString((error as any)?.message || error)}`)
        })
        return ''
      })
  }

  app.middleware(async (session: any, next: () => Promise<any>) => {
    if (session?.__rinKoishiCommandHandled) return ''
    const decision = await shouldProcessText(session, getIdentity(), registeredCommandNames)
    if (!decision.allow) return await next()
    const attachments = await extractInboundAttachments(session, chatStateDir(dataDir, decision.chatKey))
    void getController(decision.chatKey).runTurn({ text: decision.text, attachments, replyToMessageId: safeString(session?.messageId || '').trim() }, 'interrupt_prompt').catch((error) => {
      logger.warn(`koishi turn failed chatKey=${decision.chatKey} err=${safeString((error as any)?.message || error)}`)
      void sendText(app, decision.chatKey, `Koishi error: ${safeString((error as any)?.message || error || 'koishi_turn_failed')}`, safeString(session?.messageId || '').trim()).catch(() => {})
    })
    return ''
  }, true)

  const syncTelegramCommands = async () => {
    const commander = app.$commander
    if (!commander?.updateCommands) return
    for (const bot of Array.isArray(app.bots) ? app.bots : []) {
      if (safeString(bot?.platform) !== 'telegram') continue
      if (typeof bot?.updateCommands !== 'function') continue
      try {
        await commander.updateCommands(bot)
      } catch (error: any) {
        logger.warn(`koishi command sync failed platform=${safeString(bot?.platform)} selfId=${safeString(bot?.selfId)} err=${safeString(error?.message || error)}`)
      }
    }
  }

  app.on('bot-status-updated', (bot: any) => {
    if (bot?.status !== 1) return
    void syncTelegramCommands()
  })

  await app.start()
  await syncTelegramCommands()
  logger.info(`koishi started bots=${JSON.stringify(app.bots.map((bot: any) => ({ platform: bot.platform, selfId: bot.selfId, status: bot.status })))}`)

  for (const item of listChatStateFiles(path.join(dataDir, 'chats'))) {
    const controller = getController(item.chatKey)
    void controller.recoverIfNeeded().catch((error) => {
      logger.warn(`koishi recovery failed chatKey=${item.chatKey} err=${safeString((error as any)?.message || error)}`)
    })
  }

  const shutdown = async () => {
    for (const controller of controllers.values()) controller.dispose()
    try { await app.stop() } catch {}
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return { app }
}

async function main() {
  await startKoishi()
}

const isDirectEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectEntry) {
  main().catch((error: any) => {
    logger.error(String(error?.message || error || 'rin_koishi_failed'))
    process.exit(1)
  })
}
