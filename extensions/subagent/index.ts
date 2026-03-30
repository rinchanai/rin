import path from 'node:path'

import { StringEnum, type Message, type ThinkingLevel, VALID_THINKING_LEVELS } from '@mariozechner/pi-ai'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Container, Markdown, Spacer, Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

import { getBuiltinExtensionPaths } from '../../src/app/builtin-extensions.js'
import { loadRinCodingAgent } from '../../src/core/rin-lib/loader.js'
import { createConfiguredAgentSession } from '../../src/core/rin-lib/runtime.js'

const MAX_PARALLEL_TASKS = 8

const ThinkingLevelSchema = StringEnum(VALID_THINKING_LEVELS as ThinkingLevel[], {
	description: 'Thinking level: off, minimal, low, medium, high, xhigh.',
})

const TaskSchema = Type.Object({
	prompt: Type.String({ description: 'Prompt to send to the subagent.' }),
	model: Type.Optional(Type.String({ description: 'Exact model id in provider/model form, e.g. anthropic/claude-sonnet-4-5.' })),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
	cwd: Type.Optional(Type.String({ description: 'Working directory for this task. Defaults to the current project cwd.' })),
})

const ParamsSchema = Type.Object({
	action: Type.Optional(
		StringEnum(['run', 'list_models'] as const, {
			description: 'run = execute one or more subagents. list_models = show currently available models, grouped by provider.',
		}),
	),
	prompt: Type.Optional(Type.String({ description: 'Prompt for single-task mode.' })),
	model: Type.Optional(Type.String({ description: 'Exact model id in provider/model form, e.g. openai/gpt-5.4.' })),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
	cwd: Type.Optional(Type.String({ description: 'Working directory for single-task mode. Defaults to the current project cwd.' })),
	tasks: Type.Optional(Type.Array(TaskSchema, { description: 'Parallel subagent tasks. All tasks finish before the tool returns.' })),
})

type ToolParams = {
	action?: 'run' | 'list_models'
	prompt?: string
	model?: string
	thinkingLevel?: ThinkingLevel
	cwd?: string
	tasks?: Array<{
		prompt: string
		model?: string
		thinkingLevel?: ThinkingLevel
		cwd?: string
	}>
}

type UsageStats = {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	cost: number
	contextTokens: number
	turns: number
}

type TaskResult = {
	index: number
	prompt: string
	requestedModel?: string
	requestedThinkingLevel?: ThinkingLevel
	cwd: string
	status: 'pending' | 'running' | 'done' | 'error'
	exitCode: number
	stopReason?: string
	errorMessage?: string
	output: string
	model?: string
	usage: UsageStats
	messages: Message[]
}

type ProviderModelSummary = {
	provider: string
	count: number
	top3: string[]
	all: string[]
}

type SubagentDetails = {
	action: 'run' | 'list_models'
	backend: 'in-process-session'
	currentModel?: string
	currentThinkingLevel: ThinkingLevel
	providers: ProviderModelSummary[]
	results?: TaskResult[]
}

let sessionCreationQueue: Promise<unknown> = Promise.resolve()

function withSessionCreationLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = sessionCreationQueue.then(fn, fn)
	sessionCreationQueue = run.then(() => undefined, () => undefined)
	return run
}

function normalizeModelRef(value?: string): string | undefined {
	const text = String(value || '').trim()
	if (!text) return undefined
	return text.replace(/^@/, '')
}

function splitModelRef(value: string): { provider: string; modelId: string } | undefined {
	const text = normalizeModelRef(value)
	if (!text) return undefined
	const slash = text.indexOf('/')
	if (slash <= 0 || slash === text.length - 1) return undefined
	return {
		provider: text.slice(0, slash),
		modelId: text.slice(slash + 1),
	}
}

function modelSortKey(id: string): string {
	const text = id.toLowerCase()
	const date = text.match(/(20\d{2})(\d{2})(\d{2})/)
	if (date) return `4-${date[0]}`
	if (/\b(latest|preview|exp|experimental)\b/.test(text)) return `3-${text}`
	const nums = [...text.matchAll(/\d+/g)].map((m) => m[0].padStart(4, '0')).join('-')
	if (nums) return `2-${nums}-${text}`
	return `1-${text}`
}

function compareModelIds(a: string, b: string): number {
	const keyA = modelSortKey(a)
	const keyB = modelSortKey(b)
	if (keyA === keyB) return a.localeCompare(b)
	return keyB.localeCompare(keyA)
}

function formatTokens(value: number): string {
	if (!value) return '0'
	if (value < 1000) return String(value)
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`
	return `${(value / 1_000_000).toFixed(1)}M`
}

function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = []
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`)
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`)
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`)
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`)
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`)
	if (model) parts.push(model)
	return parts.join(' ')
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.role !== 'assistant') continue
		const text = msg.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim()
		if (text) return text
	}
	return ''
}

async function getProviderSummaries(ctx: any): Promise<ProviderModelSummary[]> {
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
			return {
				provider,
				count: all.length,
				top3: all.slice(0, 3),
				all,
			}
		})
		.sort((a, b) => a.provider.localeCompare(b.provider))
}

function formatModelList(details: SubagentDetails): string {
	const lines: string[] = []
	lines.push(`Backend: ${details.backend}`)
	lines.push(`Current model: ${details.currentModel ?? '(not set)'}`)
	lines.push(`Current thinking: ${details.currentThinkingLevel}`)
	lines.push('')
	if (!details.providers.length) {
		lines.push('No available models found. Configure API keys first.')
		return lines.join('\n')
	}
	lines.push('Available models by provider (latest 3 each):')
	for (const provider of details.providers) {
		lines.push(`- ${provider.provider}: ${provider.top3.join(', ') || '(none)'}${provider.count > 3 ? ` (+${provider.count - 3} more)` : ''}`)
	}
	return lines.join('\n')
}

function buildModelLookup(providers: ProviderModelSummary[]): Set<string> {
	const models = new Set<string>()
	for (const provider of providers) {
		for (const model of provider.all) models.add(`${provider.provider}/${model}`)
	}
	return models
}

function getSubagentExtensionPaths(): string[] {
	return getBuiltinExtensionPaths().filter((entry) => {
		const normalized = entry.split(path.sep).join('/')
		return !normalized.endsWith('/extensions/subagent/index.ts')
	})
}

async function createIsolatedSession(cwd: string) {
	const codingAgentModule = await loadRinCodingAgent()
	const { SessionManager } = codingAgentModule as any
	const sessionManager = SessionManager.inMemory(cwd)
	return await withSessionCreationLock(async () => {
		return await createConfiguredAgentSession({
			cwd,
			additionalExtensionPaths: getSubagentExtensionPaths(),
			sessionManager,
		})
	})
}

function summarizeTaskResult(result: TaskResult): string {
	const model = result.model || result.requestedModel || '(default model)'
	const preview = (result.output || result.errorMessage || '(no output)').replace(/\s+/g, ' ').trim()
	return `${result.index}. [${result.status}] ${model} — ${preview.slice(0, 180)}${preview.length > 180 ? '…' : ''}`
}

function buildRunUpdate(results: TaskResult[], detailsBase: SubagentDetails) {
	const done = results.filter((result) => result.status === 'done').length
	const failed = results.filter((result) => result.status === 'error').length
	const running = results.filter((result) => result.status === 'running').length
	const pending = results.filter((result) => result.status === 'pending').length
	const lines = [
		`Subagents: ${done} done, ${failed} failed, ${running} running, ${pending} pending`,
		'',
		...results.map(summarizeTaskResult),
	]
	return {
		content: [{ type: 'text' as const, text: lines.join('\n') }],
		details: { ...detailsBase, action: 'run' as const, results: results.map((result) => ({ ...result })) },
	}
}

async function runTask(
	task: { prompt: string; model?: string; thinkingLevel?: ThinkingLevel; cwd?: string },
	index: number,
	defaultCwd: string,
	signal?: AbortSignal,
	onProgress?: (result: TaskResult) => void,
): Promise<TaskResult> {
	const cwd = task.cwd || defaultCwd
	const messages: Message[] = []
	const result: TaskResult = {
		index,
		prompt: task.prompt,
		requestedModel: task.model,
		requestedThinkingLevel: task.thinkingLevel,
		cwd,
		status: 'pending',
		exitCode: 0,
		output: '',
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		messages,
	}

	const { session } = await createIsolatedSession(cwd)
	result.status = 'running'
	onProgress?.({ ...result, messages: [...result.messages] })
	const unsubscribe = session.subscribe((event: any) => {
		if (event?.type !== 'message_end' || !event.message) return
		const message = event.message as Message
		messages.push(message)
		if (message.role !== 'assistant') return
		result.output = getFinalOutput(messages)
		result.stopReason = message.stopReason
		result.errorMessage = message.errorMessage
		if (message.model) result.model = `${message.provider}/${message.model}`
		const usage = message.usage
		if (usage) {
			result.usage.turns += 1
			result.usage.input += usage.input || 0
			result.usage.output += usage.output || 0
			result.usage.cacheRead += usage.cacheRead || 0
			result.usage.cacheWrite += usage.cacheWrite || 0
			result.usage.cost += usage.cost?.total || 0
			result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens
		}
		onProgress?.({ ...result, messages: [...result.messages] })
	})

	let abortListener: (() => void) | undefined

	try {
		if (signal) {
			const onAbort = () => {
				void session.abort().catch(() => {})
			}
			if (signal.aborted) onAbort()
			else {
				signal.addEventListener('abort', onAbort, { once: true })
				abortListener = () => signal.removeEventListener('abort', onAbort)
			}
		}
		if (task.model) {
			const parts = splitModelRef(task.model)
			const model = parts ? session.modelRegistry.find(parts.provider, parts.modelId) : undefined
			if (!model) throw new Error(`Unknown model: ${task.model}`)
			await session.setModel(model)
		}
		if (task.thinkingLevel) session.setThinkingLevel(task.thinkingLevel)
		await session.prompt(task.prompt, {
			expandPromptTemplates: false,
			source: 'extension',
		})
		await session.agent.waitForIdle()
		result.output = result.output || getFinalOutput(messages)
		const failed = result.stopReason === 'error' || result.stopReason === 'aborted'
		result.exitCode = failed ? 1 : 0
		result.status = failed ? 'error' : 'done'
		onProgress?.({ ...result, messages: [...result.messages] })
		return result
	} catch (error: any) {
		result.exitCode = 1
		result.status = 'error'
		result.errorMessage = String(error?.message || error || 'subagent_failed')
		onProgress?.({ ...result, messages: [...result.messages] })
		return result
	} finally {
		abortListener?.()
		unsubscribe()
		try { await session.abort() } catch {}
		try { session.dispose?.() } catch {}
	}
}

export default function subagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'subagent',
		label: 'Subagent',
		description: 'Run isolated subagents with an explicit prompt, model, and thinking level using in-process agent sessions, or list currently available models, showing the latest 3 per provider. Supports single-task and parallel execution; parallel tasks all complete before the tool returns. Works in both std and daemon/RPC-backed modes because it uses the same session runtime underneath.',
		promptSnippet: 'Run isolated subagents with chosen prompt/model/thinking, or list currently available models (latest 3 per provider).',
		promptGuidelines: [
			'Use `subagent` by default for any simple independent task that does not need the current conversation context.',
			'If the user asks to use a subagent, use `subagent`.',
			'If the user wants another model for the work, use `subagent`.',
			'If the work can be split into parallel independent tasks, use `subagent`.',
			'Stay in the main agent only when the task clearly depends on rich current-turn context or requires tightly interleaved follow-up with your own reasoning.',
			'Call `subagent` with action `list_models` before choosing a model when model availability matters.',
			'Use exact model references in provider/model form from the tool output.',
		],
		parameters: ParamsSchema,

		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as ToolParams
			const providers = await getProviderSummaries(ctx)
			const detailsBase: SubagentDetails = {
				action: params.action === 'list_models' ? 'list_models' : 'run',
				backend: 'in-process-session',
				currentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				currentThinkingLevel: pi.getThinkingLevel(),
				providers,
			}

			if (params.action === 'list_models') {
				return {
					content: [{ type: 'text', text: formatModelList(detailsBase) }],
					details: detailsBase,
				}
			}

			const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0
			const hasSingle = Boolean(String(params.prompt || '').trim())
			if (Number(hasTasks) + Number(hasSingle) !== 1) {
				return {
					content: [{ type: 'text', text: 'Provide exactly one mode: either `prompt` for a single subagent, or `tasks` for parallel subagents.' }],
					details: detailsBase,
					isError: true,
				}
			}

			if (hasTasks && (params.tasks?.length || 0) > MAX_PARALLEL_TASKS) {
				return {
					content: [{ type: 'text', text: `Too many parallel tasks (${params.tasks?.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
					details: detailsBase,
					isError: true,
				}
			}

			const availableModels = buildModelLookup(providers)
			const tasks = hasTasks
				? (params.tasks || []).map((task) => ({
					prompt: task.prompt,
					model: normalizeModelRef(task.model),
					thinkingLevel: task.thinkingLevel,
					cwd: task.cwd,
				}))
				: [{
					prompt: String(params.prompt || ''),
					model: normalizeModelRef(params.model) || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
					thinkingLevel: params.thinkingLevel || pi.getThinkingLevel(),
					cwd: params.cwd,
				}]

			for (const task of tasks) {
				if (!String(task.prompt || '').trim()) {
					return {
						content: [{ type: 'text', text: 'Every subagent task needs a non-empty prompt.' }],
						details: detailsBase,
						isError: true,
					}
				}
				if (task.model && !availableModels.has(task.model)) {
					return {
						content: [{ type: 'text', text: `Unknown or unavailable model: ${task.model}\n\n${formatModelList(detailsBase)}` }],
						details: detailsBase,
						isError: true,
					}
				}
			}

			const progressResults = tasks.map((task, index) => ({
				index: index + 1,
				prompt: task.prompt,
				requestedModel: task.model,
				requestedThinkingLevel: task.thinkingLevel,
				cwd: task.cwd || ctx.cwd,
				status: 'pending' as const,
				exitCode: 0,
				output: '',
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				messages: [] as Message[],
			}))
			onUpdate?.(buildRunUpdate(progressResults, detailsBase))

			const results = await Promise.all(tasks.map((task, index) => runTask(task, index + 1, ctx.cwd, signal, (partial) => {
				progressResults[index] = partial
				onUpdate?.(buildRunUpdate(progressResults, detailsBase))
			})))
			const details: SubagentDetails = { ...detailsBase, action: 'run', results }
			const failed = results.filter((result) => result.exitCode !== 0)

			const text = results.length === 1
				? (results[0].output || results[0].errorMessage || '(no output)')
				: [
					`Parallel subagents finished: ${results.length - failed.length}/${results.length} succeeded`,
					...results.map((result) => {
						const status = result.exitCode === 0 ? 'ok' : 'failed'
						const preview = (result.output || result.errorMessage || '(no output)').replace(/\s+/g, ' ').trim()
						return `${result.index}. [${status}] ${result.model || result.requestedModel || '(default model)'} — ${preview.slice(0, 220)}${preview.length > 220 ? '…' : ''}`
					}),
				].join('\n\n')

			return {
				content: [{ type: 'text', text }],
				details,
				isError: failed.length > 0,
			}
		},

		renderCall(args, theme) {
			if (args.action === 'list_models') {
				return new Text(theme.fg('toolTitle', theme.bold('subagent ')) + theme.fg('accent', 'list_models'), 0, 0)
			}

			if (Array.isArray(args.tasks) && args.tasks.length > 0) {
				let text = theme.fg('toolTitle', theme.bold('subagent ')) + theme.fg('accent', `parallel (${args.tasks.length})`)
				for (const task of args.tasks.slice(0, 3)) {
					const model = task.model ? ` [${task.model}]` : ''
					const preview = String(task.prompt || '').replace(/\s+/g, ' ').trim()
					text += `\n  ${theme.fg('muted', '•')} ${theme.fg('dim', preview.slice(0, 70))}${preview.length > 70 ? '…' : ''}${theme.fg('muted', model)}`
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg('muted', `... +${args.tasks.length - 3} more`)}`
				return new Text(text, 0, 0)
			}

			const model = args.model ? ` [${args.model}]` : ''
			const preview = String(args.prompt || '').replace(/\s+/g, ' ').trim()
			return new Text(
				theme.fg('toolTitle', theme.bold('subagent ')) + theme.fg('accent', 'run') + `\n  ${theme.fg('dim', preview.slice(0, 100))}${preview.length > 100 ? '…' : ''}${theme.fg('muted', model)}`,
				0,
				0,
			)
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined
			if (!details) {
				const first = result.content[0]
				return new Text(first?.type === 'text' ? first.text : '(no output)', 0, 0)
			}

			if (details.action === 'list_models' || !details.results) {
				return new Text(formatModelList(details), 0, 0)
			}

			if (!expanded) {
				let text = theme.fg('toolTitle', theme.bold(details.results.length > 1 ? 'parallel ' : 'subagent '))
				text += theme.fg('accent', `${details.results.length} result${details.results.length > 1 ? 's' : ''}`)
				for (const task of details.results) {
					const ok = task.exitCode === 0
					const icon = ok ? theme.fg('success', '✓') : theme.fg('error', '✗')
					const preview = (task.output || task.errorMessage || '(no output)').replace(/\s+/g, ' ').trim()
					text += `\n\n${icon} ${theme.fg('accent', task.model || task.requestedModel || '(default model)')}`
					text += `\n${theme.fg('dim', preview.slice(0, 220))}${preview.length > 220 ? '…' : ''}`
					const usage = formatUsage(task.usage, undefined)
					if (usage) text += `\n${theme.fg('muted', usage)}`
				}
				text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
				return new Text(text, 0, 0)
			}

			const container = new Container()
			container.addChild(new Text(theme.fg('toolTitle', theme.bold(details.results.length > 1 ? 'parallel subagents' : 'subagent')), 0, 0))
			container.addChild(new Text(theme.fg('muted', `backend: ${details.backend}`), 0, 0))
			for (const task of details.results) {
				const ok = task.exitCode === 0
				const icon = ok ? theme.fg('success', '✓') : theme.fg('error', '✗')
				container.addChild(new Spacer(1))
				container.addChild(new Text(`${icon} ${theme.fg('accent', task.model || task.requestedModel || '(default model)')}`, 0, 0))
				container.addChild(new Text(theme.fg('muted', `cwd: ${task.cwd}`), 0, 0))
				container.addChild(new Text(theme.fg('muted', 'prompt:'), 0, 0))
				container.addChild(new Text(theme.fg('dim', task.prompt), 0, 0))
				if (task.errorMessage) container.addChild(new Text(theme.fg('error', task.errorMessage), 0, 0))
				if (task.output) {
					container.addChild(new Spacer(1))
					container.addChild(new Markdown(task.output.trim(), 0, 0))
				}
				const usage = formatUsage(task.usage, task.model)
				if (usage) container.addChild(new Text(theme.fg('muted', usage), 0, 0))
			}
			return container
		},
	})
}
