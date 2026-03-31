import net from 'node:net'

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { StringEnum } from '@mariozechner/pi-ai'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

function defaultDaemonSocketPath() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim()
  if (runtimeDir) return `${runtimeDir}/rin-daemon/daemon.sock`
  return `${process.env.HOME || ''}/.cache/rin-daemon/daemon.sock`
}

function parseChatKey(value: unknown) {
  const text = String(value || '').trim()
  return /^[^/:]+(?:\/[^:]+)?:.+$/.test(text) ? text : undefined
}

async function sendDaemon(command: any) {
  const socketPath = defaultDaemonSocketPath()
  const id = `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return await new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      try { socket.destroy() } catch {}
      reject(new Error('cron_daemon_timeout'))
    }, 30_000)

    const cleanup = () => clearTimeout(timer)
    socket.once('error', (error) => {
      cleanup()
      reject(error)
    })
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      while (true) {
        const idx = buffer.indexOf('\n')
        if (idx < 0) break
        let line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line.trim()) continue
        let payload: any
        try { payload = JSON.parse(line) } catch { continue }
        if (payload?.type !== 'response' || payload?.id !== id) continue
        cleanup()
        try { socket.destroy() } catch {}
        if (payload.success !== true) reject(new Error(String(payload.error || 'cron_request_failed')))
        else resolve(payload.data)
        return
      }
    })
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  })
}

function createTaskId() {
  return `cron_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function wrapAgentPrompt(taskId: string, taskName: string | undefined, prompt: string, chatKey: string | undefined) {
  const body = String(prompt || '').trim()
  if (!body) return body
  if (body.includes('[Scheduled task managed by manage_scheduled_tasks]')) return body
  return [
    '[Scheduled task managed by manage_scheduled_tasks]',
    `Task ID: ${taskId}`,
    taskName ? `Task name: ${taskName}` : '',
    chatKey ? `Bound chat: ${chatKey}` : '',
    'This message was triggered by a daemon scheduled task.',
    'Continue using this same session across future runs.',
    'If the recurring task is now permanently complete, call manage_scheduled_tasks with action="complete" and this task ID.',
    '',
    body,
  ].filter(Boolean).join('\n')
}

function buildTaskForSave(input: any, defaults: { currentSessionFile?: string; currentSessionId?: string; currentSessionName?: string; currentChatKey?: string }) {
  const taskId = String(input?.id || '').trim() || createTaskId()
  const taskName = String(input?.name || '').trim() || undefined
  const session = input?.session || (defaults.currentSessionFile
    ? { mode: 'current', sessionFile: defaults.currentSessionFile }
    : { mode: 'dedicated' })
  const chatKey = input?.chatKey !== undefined ? input.chatKey : defaults.currentChatKey
  const target = input?.target?.kind === 'agent_prompt'
    ? {
      kind: 'agent_prompt',
      prompt: wrapAgentPrompt(taskId, taskName, String(input?.target?.prompt || ''), typeof chatKey === 'string' ? chatKey : undefined),
    }
    : input?.target
      ? {
        kind: 'shell_command',
        command: String(input?.target?.command || ''),
        shell: input?.target?.shell,
      }
      : undefined
  return {
    ...input,
    id: taskId,
    chatKey,
    session,
    target,
  }
}

function summarizeTask(task: any) {
  const target = task?.target?.kind === 'shell_command'
    ? `command: ${String(task?.target?.command || '')}`
    : `agent: ${String(task?.target?.prompt || '')}`
  const trigger = task?.trigger?.kind === 'interval'
    ? `every ${String(task?.trigger?.intervalMs || 0)}ms`
    : task?.trigger?.kind === 'cron'
      ? `cron ${String(task?.trigger?.expression || '')}`
      : `once ${String(task?.trigger?.runAt || '')}`
  return [
    `${String(task?.id || '')}${task?.name ? ` (${String(task.name)})` : ''}`,
    trigger,
    target,
    task?.chatKey ? `chat=${String(task.chatKey)}` : '',
    `session=${String(task?.session?.mode || '')}${task?.session?.sessionFile ? `:${String(task.session.sessionFile)}` : task?.dedicatedSessionFile ? `:${String(task.dedicatedSessionFile)}` : ''}`,
    task?.completedAt ? `completed=${String(task.completedAt)}` : task?.enabled === false ? 'disabled' : `next=${String(task?.nextRunAt || 'pending')}`,
  ].filter(Boolean).join('\n')
}

function summarizeTaskForAgent(task: any) {
  const trigger = task?.trigger?.kind === 'interval'
    ? `every=${String(task?.trigger?.intervalMs || 0)}ms`
    : task?.trigger?.kind === 'cron'
      ? `cron=${String(task?.trigger?.expression || '')}`
      : `once=${String(task?.trigger?.runAt || '')}`
  const target = task?.target?.kind === 'shell_command'
    ? `command=${String(task?.target?.command || '').replace(/\s+/g, ' ').trim()}`
    : `agent_prompt=${String(task?.target?.prompt || '').replace(/\s+/g, ' ').trim()}`
  return [
    `${String(task?.id || '')}${task?.name ? ` | name=${String(task.name)}` : ''}`,
    trigger,
    target,
    task?.chatKey ? `chat=${String(task.chatKey)}` : '',
    `session=${String(task?.session?.mode || '')}${task?.session?.sessionFile ? `:${String(task.session.sessionFile)}` : task?.dedicatedSessionFile ? `:${String(task.dedicatedSessionFile)}` : ''}`,
    task?.completedAt ? `completed=${String(task.completedAt)}` : task?.enabled === false ? 'disabled' : `next=${String(task?.nextRunAt || 'pending')}`,
  ].filter(Boolean).join('\n')
}

function buildTexts(action: string, data: any, params: any) {
  const userText = action === 'list'
    ? (() => {
      const tasks = Array.isArray(data?.tasks) ? data.tasks : []
      return tasks.length
        ? ['Scheduled tasks:', ...tasks.map((task: any) => summarizeTask(task))].join('\n\n')
        : 'No scheduled tasks.'
    })()
    : data?.task
      ? summarizeTask(data.task)
      : data?.deleted
        ? `Deleted task: ${String(params?.taskId || '')}`
        : JSON.stringify(data, null, 2)

  const agentText = action === 'list'
    ? (() => {
      const tasks = Array.isArray(data?.tasks) ? data.tasks : []
      return tasks.length
        ? ['scheduled_tasks', ...tasks.map((task: any) => summarizeTaskForAgent(task))].join('\n\n')
        : 'scheduled_tasks 0'
    })()
    : data?.task
      ? summarizeTaskForAgent(data.task)
      : data?.deleted
        ? `scheduled_task deleted\nid=${String(params?.taskId || '')}`
        : `scheduled_task ${action}`

  return { agentText, userText }
}

export default function cronExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'manage_scheduled_tasks',
    label: 'Manage Scheduled Tasks',
    description: 'Create, inspect, update, pause, resume, complete, and delete daemon scheduled tasks.',
    promptSnippet: 'Manage daemon scheduled tasks for recurring, one-time, or interval-based automation.',
    promptGuidelines: [
      'Use `manage_scheduled_tasks` when the user wants reminders, recurring automation, delayed follow-ups, periodic checks, or cron-like background tasks.',
      'Prefer binding new tasks to the current session and current chat unless the user asks for an isolated session or a different target.',
      'When a scheduled agent task determines its work is finished forever, call this tool with `action: "complete"` for that task.',
    ],
    parameters: Type.Object({
      action: StringEnum(['list', 'get', 'save', 'delete', 'pause', 'resume', 'complete'] as const),
      taskId: Type.Optional(Type.String({ description: 'Required for get/delete/pause/resume/complete, and for updating an existing task via save.' })),
      reason: Type.Optional(Type.String({ description: 'Optional completion reason for action=complete.' })),
      task: Type.Optional(Type.Object({
        name: Type.Optional(Type.String({ description: 'Human-friendly task name.' })),
        enabled: Type.Optional(Type.Boolean({ description: 'Whether the task should remain enabled after saving.' })),
        chatKey: Type.Optional(Type.Union([Type.String({ description: 'Explicit bound chat key like telegram/123456:987654321 or onebot:private:12345.' }), Type.Null()])),
        cwd: Type.Optional(Type.String({ description: 'Working directory for command execution or the task session.' })),
        trigger: Type.Optional(Type.Object({
          kind: StringEnum(['interval', 'cron', 'once'] as const),
          intervalMs: Type.Optional(Type.Number({ description: 'For interval tasks. The interval is measured from task start time.' })),
          startAt: Type.Optional(Type.String({ description: 'Optional ISO timestamp for the first interval run.' })),
          expression: Type.Optional(Type.String({ description: 'Standard 5-field cron expression in local time.' })),
          runAt: Type.Optional(Type.String({ description: 'ISO timestamp for a one-time scheduled run.' })),
        })),
        termination: Type.Optional(Type.Union([
          Type.Object({
            maxRuns: Type.Optional(Type.Number({ description: 'Stop after this many runs.' })),
            stopAt: Type.Optional(Type.String({ description: 'ISO timestamp after which the task should stop.' })),
          }),
          Type.Null(),
        ])),
        session: Type.Optional(Type.Object({
          mode: StringEnum(['current', 'dedicated', 'specific'] as const),
          sessionFile: Type.Optional(Type.String({ description: 'Required for mode=specific. Optional override for mode=current.' })),
        })),
        target: Type.Optional(Type.Object({
          kind: StringEnum(['agent_prompt', 'shell_command'] as const),
          prompt: Type.Optional(Type.String({ description: 'Instruction for scheduled agent execution.' })),
          command: Type.Optional(Type.String({ description: 'Shell command for direct execution.' })),
          shell: Type.Optional(Type.String({ description: 'Optional shell path for shell_command.' })),
        })),
      })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const currentSessionFile = String(ctx.sessionManager.getSessionFile?.() || '').trim() || undefined
      const currentSessionId = String(ctx.sessionManager.getSessionId?.() || '').trim() || undefined
      const currentSessionName = String(ctx.sessionManager.getSessionName?.() || '').trim() || undefined
      const currentChatKey = parseChatKey(currentSessionName)

      const action = String((params as any)?.action || '').trim()
      let data: any
      if (action === 'list') data = await sendDaemon({ type: 'cron_list_tasks' })
      else if (action === 'get') data = await sendDaemon({ type: 'cron_get_task', taskId: (params as any)?.taskId })
      else if (action === 'save') {
        const task = buildTaskForSave({
          ...((params as any)?.task || {}),
          id: (params as any)?.taskId || (params as any)?.task?.id,
        }, {
          currentSessionFile,
          currentSessionId,
          currentSessionName,
          currentChatKey,
        })
        data = await sendDaemon({
          type: 'cron_upsert_task',
          task,
          defaults: {
            sessionFile: currentSessionFile,
            sessionId: currentSessionId,
            sessionName: currentSessionName,
            chatKey: currentChatKey,
          },
        })
      } else if (action === 'delete') data = await sendDaemon({ type: 'cron_delete_task', taskId: (params as any)?.taskId })
      else if (action === 'pause') data = await sendDaemon({ type: 'cron_pause_task', taskId: (params as any)?.taskId })
      else if (action === 'resume') data = await sendDaemon({ type: 'cron_resume_task', taskId: (params as any)?.taskId })
      else if (action === 'complete') data = await sendDaemon({ type: 'cron_complete_task', taskId: (params as any)?.taskId, reason: (params as any)?.reason })
      else throw new Error(`Unsupported action: ${action}`)

      const { agentText, userText } = buildTexts(action, data, params as any)

      return {
        content: [{ type: 'text', text: agentText }],
        details: { ...data, agentText, userText },
      }
    },
    renderResult(result) {
      const details = result.details as any
      const fallback = result.content?.[0]?.type === 'text' ? result.content[0].text : '(no output)'
      return new Text(String(details?.userText || fallback), 0, 0)
    },
  })
}
