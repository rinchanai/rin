import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { loadRinSessionManagerModule } from '../rin-lib/loader.js'
import { createConfiguredAgentSession, getRuntimeSessionDir } from '../rin-lib/runtime.js'
import { enqueueChatOutboxPayload } from '../rin-lib/chat-outbox.js'

export type CronTaskTarget = {
  kind: 'agent_prompt'
  prompt: string
} | {
  kind: 'shell_command'
  command: string
  shell?: string
}

export type CronTaskTrigger = {
  kind: 'interval'
  intervalMs: number
  startAt?: string
} | {
  kind: 'cron'
  expression: string
  timezone?: 'local'
}
| {
  kind: 'once'
  runAt: string
}

export type CronTaskTermination = {
  maxRuns?: number
  stopAt?: string
}

export type CronTaskSessionBinding = {
  mode: 'current' | 'dedicated' | 'specific'
  sessionFile?: string
}

export type CronTaskRecord = {
  id: string
  createdAt: string
  updatedAt: string
  createdFrom?: {
    sessionFile?: string
    sessionId?: string
    sessionName?: string
    chatKey?: string
  }
  name?: string
  enabled: boolean
  completedAt?: string
  completionReason?: string
  pausedAt?: string
  chatKey?: string
  cwd: string
  trigger: CronTaskTrigger
  termination?: CronTaskTermination
  session: CronTaskSessionBinding
  target: CronTaskTarget
  dedicatedSessionFile?: string
  nextRunAt?: string
  lastStartedAt?: string
  lastFinishedAt?: string
  lastResultText?: string
  lastError?: string
  runCount: number
  running: boolean
}

export type CronTaskInput = {
  id?: string
  name?: string
  enabled?: boolean
  chatKey?: string | null
  cwd?: string
  trigger?: CronTaskTrigger
  termination?: CronTaskTermination | null
  session?: CronTaskSessionBinding
  target?: CronTaskTarget
}

function safeString(value: unknown) {
  if (value == null) return ''
  return String(value)
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600) {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode })
  fs.renameSync(tmp, filePath)
  try { fs.chmodSync(filePath, mode) } catch {}
}

function normalizeIso(value: unknown, field: string) {
  const text = safeString(value).trim()
  if (!text) return undefined
  const ts = Date.parse(text)
  if (!Number.isFinite(ts)) throw new Error(`cron_invalid_${field}`)
  return new Date(ts).toISOString()
}

function nowIso() {
  return new Date().toISOString()
}

function cronRoot(agentDir: string) {
  return path.join(path.resolve(agentDir), 'data', 'cron')
}

function cronTasksPath(agentDir: string) {
  return path.join(cronRoot(agentDir), 'tasks.json')
}

function cronTaskRunId(task: CronTaskRecord) {
  return `${task.id}:${task.runCount}:${Date.now()}`
}

function summarizeText(value: string, max = 1200) {
  const text = safeString(value).replace(/\r/g, '').trim()
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

function formatCronField(field: string, min: number, max: number) {
  const allowed = new Set<number>()
  const chunks = field.split(',').map((item) => item.trim()).filter(Boolean)
  if (!chunks.length) throw new Error('cron_invalid_expression')

  for (const chunk of chunks) {
    const [rangePart, stepPart] = chunk.split('/')
    const step = stepPart == null ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step <= 0) throw new Error('cron_invalid_expression')

    let start = min
    let end = max
    if (rangePart !== '*') {
      const rangeMatch = rangePart.match(/^(\d+)(?:-(\d+))?$/)
      if (!rangeMatch) throw new Error('cron_invalid_expression')
      start = Number(rangeMatch[1])
      end = rangeMatch[2] == null ? start : Number(rangeMatch[2])
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error('cron_invalid_expression')
    }

    for (let value = start; value <= end; value += step) allowed.add(value)
  }

  return allowed
}

function nextCronAt(expression: string, afterTs: number) {
  const parts = safeString(expression).trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('cron_invalid_expression')
  const [minuteField, hourField, dayField, monthField, weekField] = parts
  const minutes = formatCronField(minuteField, 0, 59)
  const hours = formatCronField(hourField, 0, 23)
  const days = formatCronField(dayField, 1, 31)
  const months = formatCronField(monthField, 1, 12)
  const weeks = formatCronField(weekField, 0, 6)

  const start = new Date(afterTs)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  for (let i = 0; i < 366 * 24 * 60 * 2; i += 1) {
    const candidate = new Date(start.getTime() + i * 60_000)
    if (!minutes.has(candidate.getMinutes())) continue
    if (!hours.has(candidate.getHours())) continue
    if (!days.has(candidate.getDate())) continue
    if (!months.has(candidate.getMonth() + 1)) continue
    if (!weeks.has(candidate.getDay())) continue
    return candidate.toISOString()
  }

  throw new Error('cron_next_run_not_found')
}

function computeNextRunAt(task: CronTaskRecord, referenceTs: number) {
  if (task.completedAt || !task.enabled) return undefined

  if (task.termination?.stopAt) {
    const stopTs = Date.parse(task.termination.stopAt)
    if (Number.isFinite(stopTs) && referenceTs > stopTs) return undefined
  }
  if (task.termination?.maxRuns && task.runCount >= task.termination.maxRuns) return undefined

  if (task.trigger.kind === 'once') {
    const runTs = Date.parse(task.trigger.runAt)
    if (!Number.isFinite(runTs) || runTs <= referenceTs || task.runCount > 0) return undefined
    return new Date(runTs).toISOString()
  }

  if (task.trigger.kind === 'cron') {
    return nextCronAt(task.trigger.expression, referenceTs)
  }

  const intervalMs = Math.max(1_000, Number(task.trigger.intervalMs || 0))
  if (task.lastStartedAt) {
    return new Date(Date.parse(task.lastStartedAt) + intervalMs).toISOString()
  }
  const startTs = task.trigger.startAt ? Date.parse(task.trigger.startAt) : referenceTs
  return new Date(Number.isFinite(startTs) ? startTs : referenceTs).toISOString()
}

async function sendKoishiText(agentDir: string, payload: { chatKey: string; taskId: string; runId: string; text: string }) {
  enqueueChatOutboxPayload(agentDir, {
    type: 'text_delivery',
    createdAt: nowIso(),
    ...payload,
  })
}

export class CronScheduler {
  private tasks = new Map<string, CronTaskRecord>()
  private timer: NodeJS.Timeout | null = null
  private sessionManagerModulePromise = loadRinSessionManagerModule()
  private dispatching = false

  constructor(private options: { agentDir: string; cwd: string; additionalExtensionPaths?: string[] }) {}

  start() {
    this.load()
    this.timer = setInterval(() => {
      void this.tick().catch(() => {})
    }, 1000)
    void this.tick().catch(() => {})
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.save()
  }

  listTasks() {
    return Array.from(this.tasks.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((task) => JSON.parse(JSON.stringify(task)))
  }

  getTask(taskId: string) {
    const task = this.tasks.get(taskId)
    return task ? JSON.parse(JSON.stringify(task)) : undefined
  }

  upsertTask(input: CronTaskInput, defaults: { sessionFile?: string; sessionId?: string; sessionName?: string; chatKey?: string } = {}) {
    const existing = input.id ? this.tasks.get(String(input.id)) : undefined
    const id = existing?.id || safeString(input.id).trim() || `cron_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const createdAt = existing?.createdAt || nowIso()
    const updatedAt = nowIso()
    const name = input.name !== undefined ? safeString(input.name).trim() || undefined : existing?.name
    const chatKey = input.chatKey === null
      ? undefined
      : input.chatKey !== undefined
        ? safeString(input.chatKey).trim() || undefined
        : existing?.chatKey

    const cwd = input.cwd
      ? path.resolve(String(input.cwd))
      : existing?.cwd || this.options.cwd

    const trigger = input.trigger ?? existing?.trigger
    if (!trigger) throw new Error('cron_trigger_required')
    const normalizedTrigger: CronTaskTrigger = trigger.kind === 'interval'
      ? {
        kind: 'interval',
        intervalMs: Math.max(1_000, Number(trigger.intervalMs || 0)),
        startAt: normalizeIso(trigger.startAt, 'startAt'),
      }
      : trigger.kind === 'cron'
        ? {
          kind: 'cron',
          expression: safeString(trigger.expression).trim(),
          timezone: 'local',
        }
        : {
          kind: 'once',
          runAt: normalizeIso(trigger.runAt, 'runAt') || (() => { throw new Error('cron_runAt_required') })(),
        }

    const session = input.session ?? existing?.session
    if (!session) throw new Error('cron_session_required')
    const normalizedSession: CronTaskSessionBinding = {
      mode: session.mode,
      sessionFile: session.mode === 'specific'
        ? path.resolve(safeString(session.sessionFile).trim() || (() => { throw new Error('cron_sessionFile_required') })())
        : session.mode === 'current'
          ? path.resolve(safeString(session.sessionFile || defaults.sessionFile).trim() || (() => { throw new Error('cron_current_session_required') })())
          : undefined,
    }

    const target = input.target ?? existing?.target
    if (!target) throw new Error('cron_target_required')
    const normalizedTarget: CronTaskTarget = target.kind === 'agent_prompt'
      ? { kind: 'agent_prompt', prompt: safeString(target.prompt).trim() || (() => { throw new Error('cron_prompt_required') })() }
      : { kind: 'shell_command', command: safeString(target.command).trim() || (() => { throw new Error('cron_command_required') })(), shell: safeString(target.shell).trim() || undefined }

    const termination = input.termination === null
      ? undefined
      : input.termination !== undefined
        ? {
          maxRuns: input.termination?.maxRuns ? Math.max(1, Number(input.termination.maxRuns)) : undefined,
          stopAt: normalizeIso(input.termination?.stopAt, 'stopAt'),
        }
        : existing?.termination

    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : existing?.enabled ?? true
    const nextRunAt = computeNextRunAt({
      id,
      createdAt,
      updatedAt,
      createdFrom: existing?.createdFrom || {
        sessionFile: defaults.sessionFile,
        sessionId: defaults.sessionId,
        sessionName: defaults.sessionName,
        chatKey: defaults.chatKey,
      },
      name,
      enabled,
      completedAt: existing?.completedAt,
      completionReason: existing?.completionReason,
      pausedAt: existing?.pausedAt,
      chatKey,
      cwd,
      trigger: normalizedTrigger,
      termination,
      session: normalizedSession,
      target: normalizedTarget,
      dedicatedSessionFile: existing?.dedicatedSessionFile,
      nextRunAt: existing?.nextRunAt,
      lastStartedAt: existing?.lastStartedAt,
      lastFinishedAt: existing?.lastFinishedAt,
      lastResultText: existing?.lastResultText,
      lastError: existing?.lastError,
      runCount: existing?.runCount ?? 0,
      running: existing?.running ?? false,
    }, Date.now())

    const task: CronTaskRecord = {
      id,
      createdAt,
      updatedAt,
      createdFrom: existing?.createdFrom || {
        sessionFile: defaults.sessionFile,
        sessionId: defaults.sessionId,
        sessionName: defaults.sessionName,
        chatKey: defaults.chatKey,
      },
      name,
      enabled,
      completedAt: existing?.completedAt,
      completionReason: existing?.completionReason,
      pausedAt: existing?.pausedAt,
      chatKey,
      cwd,
      trigger: normalizedTrigger,
      termination,
      session: normalizedSession,
      target: normalizedTarget,
      dedicatedSessionFile: existing?.dedicatedSessionFile,
      nextRunAt,
      lastStartedAt: existing?.lastStartedAt,
      lastFinishedAt: existing?.lastFinishedAt,
      lastResultText: existing?.lastResultText,
      lastError: existing?.lastError,
      runCount: existing?.runCount ?? 0,
      running: existing?.running ?? false,
    }

    if (task.completedAt) {
      task.enabled = false
      task.nextRunAt = undefined
    }

    this.tasks.set(task.id, task)
    this.save()
    return JSON.parse(JSON.stringify(task))
  }

  deleteTask(taskId: string) {
    const ok = this.tasks.delete(taskId)
    if (ok) this.save()
    return ok
  }

  completeTask(taskId: string, reason = 'completed_by_agent') {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`cron_task_not_found:${taskId}`)
    task.completedAt = nowIso()
    task.completionReason = safeString(reason).trim() || 'completed'
    task.enabled = false
    task.running = false
    task.nextRunAt = undefined
    task.updatedAt = nowIso()
    this.save()
    return JSON.parse(JSON.stringify(task))
  }

  pauseTask(taskId: string) {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`cron_task_not_found:${taskId}`)
    task.enabled = false
    task.pausedAt = nowIso()
    task.nextRunAt = undefined
    task.updatedAt = nowIso()
    this.save()
    return JSON.parse(JSON.stringify(task))
  }

  resumeTask(taskId: string) {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`cron_task_not_found:${taskId}`)
    task.enabled = true
    delete task.pausedAt
    task.nextRunAt = computeNextRunAt(task, Date.now())
    task.updatedAt = nowIso()
    this.save()
    return JSON.parse(JSON.stringify(task))
  }

  private load() {
    const file = cronTasksPath(this.options.agentDir)
    const rows = readJson<CronTaskRecord[]>(file, [])
    this.tasks.clear()
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !row.id) continue
      row.running = false
      row.lastError = row.lastError ? safeString(row.lastError) : undefined
      row.nextRunAt = row.completedAt ? undefined : row.nextRunAt || computeNextRunAt(row, Date.now())
      this.tasks.set(String(row.id), row)
    }
    this.save()
  }

  private save() {
    writeJsonAtomic(cronTasksPath(this.options.agentDir), Array.from(this.tasks.values()))
  }

  private async tick() {
    if (this.dispatching) return
    this.dispatching = true
    try {
      const now = Date.now()
      const due = Array.from(this.tasks.values())
        .filter((task) => task.enabled && !task.running && !task.completedAt && task.nextRunAt && Date.parse(task.nextRunAt) <= now)
        .sort((a, b) => Date.parse(String(a.nextRunAt || a.createdAt)) - Date.parse(String(b.nextRunAt || b.createdAt)))
      for (const task of due) {
        task.running = true
        task.lastStartedAt = nowIso()
        task.runCount += 1
        task.lastError = undefined
        task.updatedAt = nowIso()
        if (task.trigger.kind === 'interval') {
          task.nextRunAt = computeNextRunAt(task, Date.now())
        } else if (task.trigger.kind === 'cron') {
          task.nextRunAt = nextCronAt(task.trigger.expression, Date.now())
        } else {
          task.nextRunAt = undefined
        }
        this.save()
        void this.executeTask(task).catch(() => {})
      }
    } finally {
      this.dispatching = false
    }
  }

  private async resolveSessionFile(task: CronTaskRecord) {
    if (task.session.mode === 'specific' || task.session.mode === 'current') {
      return task.session.sessionFile
    }
    if (task.dedicatedSessionFile) return task.dedicatedSessionFile
    return undefined
  }

  private async executeTask(task: CronTaskRecord) {
    const runId = cronTaskRunId(task)
    try {
      if (task.target.kind === 'shell_command') {
        const result = await this.executeShellTask(task)
        task.lastResultText = result
        if (task.chatKey) {
          await sendKoishiText(this.options.agentDir, {
            chatKey: task.chatKey,
            taskId: task.id,
            runId,
            text: [`[Scheduled task${task.name ? `: ${task.name}` : ''}]`, result].filter(Boolean).join('\n\n'),
          }).catch(() => {})
        }
      } else {
        const result = await this.executeAgentTask(task)
        task.lastResultText = result
        if (task.chatKey && result) {
          await sendKoishiText(this.options.agentDir, {
            chatKey: task.chatKey,
            taskId: task.id,
            runId,
            text: [`[Scheduled task${task.name ? `: ${task.name}` : ''}]`, result].filter(Boolean).join('\n\n'),
          }).catch(() => {})
        }
      }
    } catch (error: any) {
      task.lastError = safeString(error?.message || error || 'cron_task_failed')
      if (task.chatKey) {
        await sendKoishiText(this.options.agentDir, {
          chatKey: task.chatKey,
          taskId: task.id,
          runId,
          text: `[Scheduled task${task.name ? `: ${task.name}` : ''}] failed\n\n${task.lastError}`,
        }).catch(() => {})
      }
    } finally {
      task.running = false
      task.lastFinishedAt = nowIso()
      task.updatedAt = nowIso()
      if (!task.completedAt && task.termination?.maxRuns && task.runCount >= task.termination.maxRuns) {
        task.completedAt = nowIso()
        task.completionReason = 'max_runs_reached'
        task.enabled = false
        task.nextRunAt = undefined
      }
      if (!task.completedAt && task.termination?.stopAt) {
        const stopTs = Date.parse(task.termination.stopAt)
        if (Number.isFinite(stopTs) && Date.now() >= stopTs) {
          task.completedAt = nowIso()
          task.completionReason = 'stop_time_reached'
          task.enabled = false
          task.nextRunAt = undefined
        }
      }
      if (!task.completedAt && task.trigger.kind !== 'interval') {
        task.nextRunAt = computeNextRunAt(task, Date.now())
      }
      this.save()
    }
  }

  private async executeShellTask(task: CronTaskRecord) {
    if (task.target.kind !== 'shell_command') throw new Error('cron_invalid_shell_task')
    const { command } = task.target
    const shell = task.target.shell || process.env.SHELL || '/bin/sh'
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(shell, ['-lc', command], {
        cwd: task.cwd || this.options.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', (code, signal) => {
        const body = [
          `Command: ${command}`,
          `Exit: ${signal ? `signal ${signal}` : code ?? 0}`,
          stdout.trim() ? `stdout:\n${summarizeText(stdout, 4000)}` : '',
          stderr.trim() ? `stderr:\n${summarizeText(stderr, 4000)}` : '',
        ].filter(Boolean).join('\n\n')
        if (code === 0 && !signal) resolve(body)
        else reject(new Error(body || 'cron_command_failed'))
      })
    })
  }

  private async executeAgentTask(task: CronTaskRecord) {
    if (task.target.kind !== 'agent_prompt') throw new Error('cron_invalid_agent_task')
    const { prompt } = task.target
    const { SessionManager } = await this.sessionManagerModulePromise
    const targetSessionFile = await this.resolveSessionFile(task)
    const sessionDir = getRuntimeSessionDir(task.cwd || this.options.cwd, this.options.agentDir)
    const sessionManager = targetSessionFile
      ? SessionManager.open(targetSessionFile, sessionDir)
      : SessionManager.create(task.cwd || this.options.cwd, sessionDir)
    const { session } = await createConfiguredAgentSession({
      cwd: task.cwd || this.options.cwd,
      agentDir: this.options.agentDir,
      additionalExtensionPaths: this.options.additionalExtensionPaths ?? [],
      sessionManager,
    })
    try {
      await session.prompt(prompt, {
        expandPromptTemplates: false,
        source: 'rpc' as any,
      })
      await session.agent.waitForIdle()
      const sessionFile = safeString(session.sessionFile || session.sessionManager?.getSessionFile?.() || '').trim() || undefined
      if (task.session.mode === 'dedicated' && sessionFile) task.dedicatedSessionFile = sessionFile
      const finalText = summarizeText(safeString(session.getLastAssistantText?.() || ''), 4000)
      return finalText || `Scheduled agent turn finished in session ${sessionFile || '(ephemeral)'}`
    } finally {
      try { await session.abort() } catch {}
    }
  }
}
