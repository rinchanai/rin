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
		Type.Literal('compile'),
		Type.Literal('doctor'),
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
	sensitivity: Type.Optional(Type.String()),
	source: Type.Optional(Type.String()),
	section: Type.Optional(Type.Union([
		Type.Literal('resident'),
		Type.Literal('progressive'),
		Type.Literal('all'),
	])),
	limit: Type.Optional(Type.Number({ minimum: 1 })),
})

export function resolveAgentDir(): string {
	const fromEnv = String(process.env.PI_CODING_AGENT_DIR || process.env.RIN_DIR || '').trim()
	return fromEnv ? path.resolve(fromEnv) : path.join(process.env.HOME || '', '.rin')
}

export function buildCompiledMemoryPrompt(result: any): string {
	const resident = String(result?.resident || '').trim()
	const progressive = String(result?.progressive || '').trim()
	const blocks: string[] = []
	if (resident) blocks.push(['## Resident Memory', resident].join('\n'))
	if (progressive) blocks.push(['## Progressive Memory Index', progressive].join('\n'))
	return blocks.join('\n\n').trim()
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
				return `- ${String(item?.title || item?.id || '(untitled)')} [${String(item?.exposure || '')}]${slot ? ` slot=${slot}` : ''}${tags} path=${String(item?.path || '')}`
			}),
		].join('\n')
	}

	if (action === 'search') {
		const rows = Array.isArray(response?.results) ? response.results : []
		if (!rows.length) return `No memory matches for: ${String(response?.query || '')}`
		return [
			`Memory matches for: ${String(response?.query || '')}`,
			...rows.map((item: any, index: number) => {
				const summary = String(item?.summary || '').trim()
				const meta = [
					`score=${Number(item?.score || 0).toFixed(2)}`,
					String(item?.exposure || '').trim(),
					String(item?.resident_slot || '').trim(),
				].filter(Boolean).join(' • ')
				return [`${index + 1}. ${String(item?.title || item?.id || '(untitled)')} — ${meta}`, String(item?.path || ''), summary].filter(Boolean).join('\n')
			}),
		].join('\n\n')
	}

	if (action === 'get') {
		const meta = [
			`id=${String(response?.id || '')}`,
			`exposure=${String(response?.exposure || '')}`,
			response?.resident_slot ? `slot=${String(response.resident_slot)}` : '',
			`path=${String(response?.path || '')}`,
		].filter(Boolean).join(' • ')
		return [String(response?.title || response?.id || 'Memory document'), meta, String(response?.content || '').trim()].filter(Boolean).join('\n\n')
	}

	if (action === 'save') {
		return `Saved memory: ${String(response?.doc?.title || response?.doc?.id || '')}\n${String(response?.doc?.path || '')}`
	}

	if (action === 'delete') {
		return `Deleted memory: ${String(response?.id || '')}\n${String(response?.path || '')}`
	}

	if (action === 'compile') {
		const prompt = buildCompiledMemoryPrompt(response)
		return prompt || 'No compiled memory available.'
	}

	return JSON.stringify(response, null, 2)
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

export async function compilePromptMemory() {
	const service = await loadMemoryService()
	const compiled = service.compileMemorySync({ section: 'all', progressiveLimit: 12 }, resolveAgentDir())
	return buildCompiledMemoryPrompt(compiled)
}
