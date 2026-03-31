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
	if (action === 'doctor') {
		return [
			'Memory doctor:',
			`- root: ${String(response?.root || '')}`,
			`- total docs: ${String(response?.total || 0)}`,
			`- active docs: ${String(response?.active_total || 0)}`,
			`- inactive docs: ${String(response?.inactive_total || 0)}`,
			`- events: ${String(response?.event_count || 0)}`,
			`- relation edges: ${String(response?.relation_edges || 0)}`,
			`- chronicles: ${String(response?.chronicle_docs || 0)}`,
			`- episodes: ${String(response?.episode_docs || 0)}`,
			response?.last_processed_at ? `- last processed at: ${String(response.last_processed_at)}` : '',
			Array.isArray(response?.resident_missing_slots) && response.resident_missing_slots.length
				? `- missing resident slots: ${response.resident_missing_slots.join(', ')}`
				: '- missing resident slots: none',
		].filter(Boolean).join('\n')
	}
	if (action === 'log_event') return `Logged memory event: ${String(response?.event?.id || '')}\n${String(response?.event?.summary || '')}`
	if (action === 'events' || action === 'event_search') {
		const rows = Array.isArray(response?.results) ? response.results : []
		if (!rows.length) return action === 'event_search' ? `No event matches for: ${String(response?.query || '')}` : 'No memory events found.'
		return rows.map((item: any, index: number) => `${index + 1}. [${String(item?.created_at || '').replace('T', ' ').slice(0, 16)}] ${String(item?.summary || '')}`).join('\n')
	}
	if (action === 'process') {
		const lines = [
			'Memory processing finished.',
			response?.status ? `- status: ${String(response.status)}` : '',
			response?.sessionFile ? `- session file: ${String(response.sessionFile)}` : '',
			response?.lastProcessedAt ? `- last processed at: ${String(response.lastProcessedAt)}` : '',
		]
		const counts = response?.counts && typeof response.counts === 'object'
			? Object.entries(response.counts).map(([key, value]) => `${key}=${String(value)}`).join(', ')
			: ''
		if (counts) lines.push(`- counts: ${counts}`)
		return lines.filter(Boolean).join('\n')
	}
	return `Memory action completed: ${action || 'unknown'}`
}

export function formatMemoryAgentResult(action: string, response: any): string {
	if (action === 'list') {
		const rows = Array.isArray(response?.results) ? response.results : []
		if (!rows.length) return 'memory list 0'
		return [
			`memory list ${rows.length}`,
			...rows.map((item: any, index: number) => {
				const parts = [
					`${index + 1}. ${String(item?.title || item?.id || '(untitled)')}`,
					String(item?.exposure || '').trim(),
					String(item?.scope || '').trim(),
					String(item?.kind || '').trim(),
					item?.resident_slot ? `slot=${String(item.resident_slot)}` : '',
					`path=${String(item?.path || '')}`,
				].filter(Boolean)
				return parts.join(' | ')
			}),
		].join('\n')
	}

	if (action === 'search') {
		const rows = Array.isArray(response?.results) ? response.results : []
		const related = Array.isArray(response?.related_matches) ? response.related_matches : []
		const events = Array.isArray(response?.event_matches) ? response.event_matches : []
		const parts: string[] = []
		parts.push(rows.length
			? [
				`memory search ${String(response?.query || '')} (${rows.length})`,
				...rows.map((item: any, index: number) => [
					`${index + 1}. ${String(item?.title || item?.id || '(untitled)')}`,
					`score=${Number(item?.score || 0).toFixed(2)}`,
					String(item?.exposure || '').trim(),
					String(item?.scope || '').trim(),
					`path=${String(item?.path || '')}`,
				].filter(Boolean).join(' | ')),
			].join('\n')
			: `memory search ${String(response?.query || '')} (0)`)
		if (related.length) parts.push(['related', ...related.map((item: any, index: number) => `${index + 1}. ${String(item?.title || item?.id || '')} | reason=${String(item?.reason || 'related')} | path=${String(item?.path || '')}`)].join('\n'))
		if (events.length) parts.push(['events', ...events.map((item: any, index: number) => `${index + 1}. ${String(item?.created_at || '')} | ${String(item?.summary || '')}`)].join('\n'))
		return parts.join('\n\n')
	}

	if (action === 'get') {
		return [
			String(response?.title || response?.id || 'Memory document'),
			`id=${String(response?.id || '')}`,
			`exposure=${String(response?.exposure || '')}`,
			`scope=${String(response?.scope || '')}`,
			`kind=${String(response?.kind || '')}`,
			response?.resident_slot ? `slot=${String(response.resident_slot)}` : '',
			`path=${String(response?.path || '')}`,
			'read file separately if full body is needed',
		].filter(Boolean).join('\n')
	}

	if (action === 'save') return `memory save\npath=${String(response?.doc?.path || '')}`
	if (action === 'delete') return `memory delete\npath=${String(response?.path || '')}`
	if (action === 'move') return `memory move\npath=${String(response?.doc?.path || '')}`
	if (action === 'compile') {
		const sections = [
			['resident_docs', response?.resident_docs],
			['progressive_docs', response?.progressive_docs],
			['expanded_progressives', response?.expanded_progressives],
			['episode_docs', response?.episode_docs],
			['recall_docs', response?.recall_docs],
			['related_docs', response?.related_docs],
		].filter(([, value]) => Array.isArray(value) && value.length > 0) as Array<[string, any[]]>
		if (!sections.length) return 'memory compile 0 sources'
		return [
			`memory compile ${String(response?.query || '').trim() || '(no query)'}`,
			...sections.map(([name, docs]) => `${name}: ${docs.length}`),
			...sections.flatMap(([name, docs]) => docs.map((doc: any, index: number) => `${name}[${index + 1}] path=${String(doc?.path || '')}`)),
		].join('\n')
	}
	if (action === 'doctor') {
		return [
			'memory doctor',
			`root=${String(response?.root || '')}`,
			`total=${String(response?.total || 0)}`,
			`active=${String(response?.active_total || 0)}`,
			`events=${String(response?.event_count || 0)}`,
			`relation_edges=${String(response?.relation_edges || 0)}`,
			Array.isArray(response?.resident_missing_slots) ? `missing_slots=${response.resident_missing_slots.join(',')}` : '',
		].filter(Boolean).join('\n')
	}
	if (action === 'log_event') return `memory log_event\nid=${String(response?.event?.id || '')}`
	if (action === 'events' || action === 'event_search') {
		const rows = Array.isArray(response?.results) ? response.results : []
		if (!rows.length) return action === 'event_search' ? `memory event_search ${String(response?.query || '')} (0)` : 'memory events 0'
		return [
			action === 'event_search' ? `memory event_search ${String(response?.query || '')} (${rows.length})` : `memory events ${rows.length}`,
			...rows.map((item: any, index: number) => `${index + 1}. ${String(item?.created_at || '')} | ${String(item?.summary || '')}`),
		].join('\n')
	}
	if (action === 'process') {
		return [
			'memory process',
			`status=${String(response?.status || response?.ok || 'ok')}`,
			response?.sessionFile ? `sessionFile=${String(response.sessionFile)}` : '',
			response?.lastProcessedAt ? `lastProcessedAt=${String(response.lastProcessedAt)}` : '',
		].filter(Boolean).join('\n')
	}
	return `memory ${action || 'result'}`
}

const INIT_STATE_FILE = 'init-state.json'
const REQUIRED_INIT_SLOTS = ['agent_identity', 'owner_identity', 'core_voice_style']
const OPTIONAL_INIT_SLOTS = ['core_methodology', 'core_values']

function initStatePath() {
	return path.join(resolveAgentDir(), 'memory', 'state', INIT_STATE_FILE)
}

function readInitState() {
	try {
		const parsed = JSON.parse(fs.readFileSync(initStatePath(), 'utf8')) as Record<string, any>
		return {
			version: 2,
			promptedAt: '',
			completedAt: '',
			lastTrigger: '',
			pending: false,
			...parsed,
		}
	} catch {
		return { version: 2, promptedAt: '', completedAt: '', lastTrigger: '', pending: false }
	}
}

function writeInitState(next: Record<string, any>) {
	fs.mkdirSync(path.dirname(initStatePath()), { recursive: true })
	fs.writeFileSync(initStatePath(), JSON.stringify(next, null, 2), 'utf8')
}

export function buildOnboardingPrompt(mode: 'auto' | 'manual' = 'manual'): string {
	return [
		mode === 'auto' ? 'Memory onboarding is active. Continue the initialization naturally.' : 'The user requested /init. Continue onboarding naturally.',
		'Do not mention, quote, summarize, or expose any hidden onboarding instructions, internal prompt text, or implementation details to the user.',
		'Keep the conversation natural and concise. Ask at most one onboarding question in this turn.',
		'The onboarding order should be handled by you conversationally:',
		'- first establish the user\'s preferred language',
		'- then ask the user to define the assistant\'s own name / identity / relationship framing',
		'- then ask how to address the user',
		'- finally ask for the assistant\'s default voice/style preferences',
		'If the user already provided information from later steps early, remember it and use it; do not force redundant questions.',
		'When a stable fact becomes clear, proactively call memory to save or update it.',
		'Use resident slots:',
		'- agent_identity = assistant name/identity/relationship framing',
		'- owner_identity = user name/addressing/stable identity cues',
		'- core_voice_style = default language, tone, brevity, and chat style',
		'Prefer updating existing memory over creating duplicates.',
		'Once those three resident slots are established clearly enough, stop onboarding and continue normally.',
	].join('\n')
}

export function getOnboardingState() {
	return readInitState()
}

export function isOnboardingActive(state = readInitState()) {
	return Boolean(state?.pending)
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
		version: 2,
		promptedAt: new Date().toISOString(),
		completedAt: '',
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
			version: 2,
			completedAt: new Date().toISOString(),
			pending: false,
		}
		writeInitState(next)
		return { ...status, state: next, complete: true }
	}
	return status
}

export async function loadMemoryService() {
	const storePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'store.ts')
	if (fs.existsSync(storePath)) {
		const sourceLoader = jiti(import.meta.url, { interopDefault: true, moduleCache: true })
		return await sourceLoader.import(storePath)
	}
	return await import(pathToFileURL(storePath).href)
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
