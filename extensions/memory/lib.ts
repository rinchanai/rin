import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Type } from '@sinclair/typebox'
import jiti from '@mariozechner/jiti'

export const memoryToolParameters = Type.Object({
	action: Type.Union([
		Type.Literal('list'),
		Type.Literal('search'),
		Type.Literal('get'),
		Type.Literal('save'),
		Type.Literal('delete'),
		Type.Literal('move'),
		Type.Literal('compile'),
		Type.Literal('doctor'),
		Type.Literal('log_event'),
		Type.Literal('events'),
		Type.Literal('event_search'),
		Type.Literal('process'),
	]),
	query: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	exposure: Type.Optional(Type.Union([
		Type.Literal('resident'),
		Type.Literal('progressive'),
		Type.Literal('recall'),
	])),
	fidelity: Type.Optional(Type.Union([
		Type.Literal('exact'),
		Type.Literal('fuzzy'),
	])),
	residentSlot: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Array(Type.String())),
	aliases: Type.Optional(Type.Array(Type.String())),
	triggers: Type.Optional(Type.Array(Type.String())),
	scope: Type.Optional(Type.Union([
		Type.Literal('global'),
		Type.Literal('domain'),
		Type.Literal('project'),
		Type.Literal('session'),
	])),
	kind: Type.Optional(Type.Union([
		Type.Literal('identity'),
		Type.Literal('style'),
		Type.Literal('method'),
		Type.Literal('value'),
		Type.Literal('preference'),
		Type.Literal('rule'),
		Type.Literal('knowledge'),
		Type.Literal('history'),
	])),
	status: Type.Optional(Type.Union([
		Type.Literal('active'),
		Type.Literal('superseded'),
		Type.Literal('invalidated'),
	])),
	observationCount: Type.Optional(Type.Number({ minimum: 1 })),
	supersedes: Type.Optional(Type.Array(Type.String())),
	sensitivity: Type.Optional(Type.String()),
	source: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number({ minimum: 1 })),
	since: Type.Optional(Type.String()),
	sessionFile: Type.Optional(Type.String()),
	kindFilter: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
	created_at: Type.Optional(Type.String()),
	toolName: Type.Optional(Type.String()),
	isError: Type.Optional(Type.Boolean()),
})

export function resolveAgentDir(): string {
	const fromEnv = String(process.env.PI_CODING_AGENT_DIR || process.env.RIN_DIR || '').trim()
	return fromEnv ? path.resolve(fromEnv) : path.join(process.env.HOME || '', '.rin')
}

export function buildCompiledMemoryPrompt(result: any): string {
	const blocks = [
		['## Resident Memory', String(result?.resident || '').trim()],
		['## Progressive Memory', String(result?.progressive_index || '').trim()],
		['## Expanded Progressive Memory', String(result?.progressive_expanded || '').trim()],
		['## Episode Memory', String(result?.episode_context || '').trim()],
		['## Relevant Recall', String(result?.recall_context || '').trim()],
		['## Related Memory', String(result?.related_context || '').trim()],
		['## Relevant Recent History', String(result?.recent_history || '').trim()],
	].filter(([, body]) => body)
	return blocks.map(([title, body]) => `${title}\n${body}`).join('\n\n').trim()
}

export function buildSystemPromptMemory(result: any): string {
	const blocks = [
		['## Resident Memory', String(result?.resident || '').trim()],
		['## Progressive Memory', String(result?.progressive_index || '').trim()],
	].filter(([, body]) => body)
	return blocks.map(([title, body]) => `${title}\n${body}`).join('\n\n').trim()
}

export function formatMemoryResult(action: string, response: any): string {
	if (action === 'list') {
		const rows = Array.isArray(response?.results) ? response.results : []
		if (!rows.length) return 'No memory documents found.'
		return [
			`Memory documents (${rows.length}):`,
			...rows.map((item: any) => {
				const slot = String(item?.resident_slot || '').trim()
				const tags = Array.isArray(item?.tags) && item.tags.length ? ` tags=${item.tags.join(',')}` : ''
				const scope = String(item?.scope || '').trim()
				const kind = String(item?.kind || '').trim()
				return `- ${String(item?.title || item?.id || '(untitled)')} [${String(item?.exposure || '')}]${scope ? ` scope=${scope}` : ''}${kind ? ` kind=${kind}` : ''}${slot ? ` slot=${slot}` : ''}${tags} path=${String(item?.path || '')}`
			}),
		].join('\n')
	}

	if (action === 'search') {
		const rows = Array.isArray(response?.results) ? response.results : []
		const events = Array.isArray(response?.event_matches) ? response.event_matches : []
		const related = Array.isArray(response?.related_matches) ? response.related_matches : []
		const parts: string[] = []
		parts.push(rows.length
			? [
				`Memory matches for: ${String(response?.query || '')}`,
				...rows.map((item: any, index: number) => {
					const summary = String(item?.summary || '').trim()
					const meta = [
						`score=${Number(item?.score || 0).toFixed(2)}`,
						String(item?.exposure || '').trim(),
						String(item?.scope || '').trim(),
					].filter(Boolean).join(' • ')
					return [`${index + 1}. ${String(item?.title || item?.id || '(untitled)')} — ${meta}`, String(item?.path || ''), summary].filter(Boolean).join('\n')
				}),
			].join('\n\n')
			: `No memory matches for: ${String(response?.query || '')}`)
		if (related.length) {
			parts.push([
				'Related memory edges:',
				...related.map((item: any, index: number) => `${index + 1}. ${String(item?.title || item?.id || '')} (${String(item?.reason || 'related')})`),
			].join('\n'))
		}
		if (events.length) {
			parts.push([
				'Relevant event ledger entries:',
				...events.map((item: any, index: number) => `${index + 1}. [${String(item?.created_at || '').replace('T', ' ').slice(0, 16)}] ${String(item?.summary || '')}`),
			].join('\n'))
		}
		return parts.join('\n\n')
	}

	if (action === 'get') {
		const meta = [
			`id=${String(response?.id || '')}`,
			`exposure=${String(response?.exposure || '')}`,
			`scope=${String(response?.scope || '')}`,
			`kind=${String(response?.kind || '')}`,
			response?.resident_slot ? `slot=${String(response.resident_slot)}` : '',
			`path=${String(response?.path || '')}`,
		].filter(Boolean).join(' • ')
		return [String(response?.title || response?.id || 'Memory document'), meta, String(response?.content || '').trim()].filter(Boolean).join('\n\n')
	}

	if (action === 'save') return `Saved memory: ${String(response?.doc?.title || response?.doc?.id || '')}\n${String(response?.doc?.path || '')}`
	if (action === 'delete') return `Deleted memory: ${String(response?.id || '')}\n${String(response?.path || '')}`
	if (action === 'move') return `Moved memory: ${String(response?.doc?.title || response?.doc?.id || '')}\n${String(response?.doc?.path || '')}`
	if (action === 'compile') return buildCompiledMemoryPrompt(response) || 'No compiled memory available.'
	if (action === 'doctor') return JSON.stringify(response, null, 2)
	if (action === 'log_event') return `Logged memory event: ${String(response?.event?.id || '')}\n${String(response?.event?.summary || '')}`
	if (action === 'events' || action === 'event_search') {
		const rows = Array.isArray(response?.results) ? response.results : []
		if (!rows.length) return action === 'event_search' ? `No event matches for: ${String(response?.query || '')}` : 'No memory events found.'
		return rows.map((item: any, index: number) => `${index + 1}. [${String(item?.created_at || '').replace('T', ' ').slice(0, 16)}] ${String(item?.summary || '')}`).join('\n')
	}
	if (action === 'process') return JSON.stringify(response, null, 2)
	return JSON.stringify(response, null, 2)
}

const INIT_STATE_FILE = 'init-state.json'
const REQUIRED_INIT_SLOTS = ['agent_identity', 'owner_identity', 'core_voice_style']
const OPTIONAL_INIT_SLOTS = ['core_methodology', 'core_values']

function initStatePath() {
	return path.join(resolveAgentDir(), 'memory', 'state', INIT_STATE_FILE)
}

function readInitState() {
	try {
		return JSON.parse(fs.readFileSync(initStatePath(), 'utf8')) as Record<string, any>
	} catch {
		return { version: 1, promptedAt: '', completedAt: '', lastTrigger: '', pending: false }
	}
}

function writeInitState(next: Record<string, any>) {
	fs.mkdirSync(path.dirname(initStatePath()), { recursive: true })
	fs.writeFileSync(initStatePath(), JSON.stringify(next, null, 2), 'utf8')
}

export function buildOnboardingPrompt(mode: 'auto' | 'manual' = 'manual'): string {
	return [
		'[Memory onboarding request]',
		mode === 'auto' ? 'Start the initial onboarding conversation now.' : 'The user requested /init. Start onboarding now.',
		'Establish these early in the conversation:',
		'- how to address the user',
		'- the relationship / identity framing between user and assistant',
		'- the default language / tone / style',
		'Then continue naturally through ordinary chat and capture any stable details that emerge.',
		'When those three become clear, proactively call rin_memory to save them into owner_identity, agent_identity, and core_voice_style.',
		'When newer user statements replace older ones, update memory with the newer version.',
		'Save clear long-term facts with rin_memory using these resident slots:',
		'- owner_identity = user addressing and stable user identity cues',
		'- agent_identity = assistant identity and relationship framing',
		'- core_voice_style = default language, tone, brevity, and chat style',
		'Use progressive for longer cross-task guidance. Use recall for project or contextual material.',
	].join('\n')
}

export async function getOnboardingStatus() {
	const service = await loadMemoryService()
	const doctor = await service.doctorMemory(resolveAgentDir())
	const missing = Array.isArray(doctor?.resident_missing_slots) ? doctor.resident_missing_slots : []
	const requiredMissing = REQUIRED_INIT_SLOTS.filter((slot) => missing.includes(slot))
	const optionalMissing = OPTIONAL_INIT_SLOTS.filter((slot) => missing.includes(slot))
	const state = readInitState()
	const complete = requiredMissing.length === 0
	return {
		state,
		doctor,
		requiredMissing,
		optionalMissing,
		complete,
	}
}

export async function markOnboardingPrompted(trigger: string) {
	const state = readInitState()
	const next = {
		...state,
		version: 1,
		promptedAt: new Date().toISOString(),
		lastTrigger: trigger,
		pending: true,
	}
	writeInitState(next)
	return next
}

export async function refreshOnboardingCompletion() {
	const status = await getOnboardingStatus()
	if (status.complete) {
		const next = {
			...status.state,
			version: 1,
			completedAt: new Date().toISOString(),
			pending: false,
		}
		writeInitState(next)
		return { ...status, state: next, complete: true }
	}
	return status
}

export async function loadMemoryService() {
	const servicePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'service.ts')
	if (fs.existsSync(servicePath)) {
		const sourceLoader = jiti(import.meta.url, { interopDefault: true, moduleCache: true })
		return await sourceLoader.import(servicePath)
	}
	return await import(pathToFileURL(servicePath).href)
}

export async function executeMemoryTool(params: any) {
	const service = await loadMemoryService()
	return await service.executeMemoryAction(params, resolveAgentDir())
}

export async function compilePromptMemory(query = '') {
	const service = await loadMemoryService()
	const compiled = await service.compileMemory({
		query,
		progressiveLimit: 12,
		expandedProgressiveLimit: 2,
		recallLimit: 3,
		historyLimit: 3,
	}, resolveAgentDir())
	return {
		compiled,
		prompt: buildCompiledMemoryPrompt(compiled),
		systemPrompt: buildSystemPromptMemory(compiled),
	}
}
