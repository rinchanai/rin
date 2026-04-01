import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Type } from '@sinclair/typebox'

import { buildCompiledMemoryPrompt, buildSystemPromptMemory, formatMemoryAgentResult, formatMemoryResult } from './format.js'
import {
	buildOnboardingPrompt as buildOnboardingPromptBase,
	getOnboardingState as getOnboardingStateBase,
	getOnboardingStatus as getOnboardingStatusBase,
	isOnboardingActive as isOnboardingActiveBase,
	markOnboardingPrompted as markOnboardingPromptedBase,
	refreshOnboardingCompletion as refreshOnboardingCompletionBase,
} from './onboarding.js'

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

export { buildCompiledMemoryPrompt, buildSystemPromptMemory, formatMemoryResult, formatMemoryAgentResult }

export function buildOnboardingPrompt(mode: 'auto' | 'manual' = 'manual'): string {
	return buildOnboardingPromptBase(mode)
}

export function getOnboardingState() {
	return getOnboardingStateBase(resolveAgentDir)
}

export function isOnboardingActive(state = getOnboardingStateBase(resolveAgentDir)) {
	return isOnboardingActiveBase(resolveAgentDir, state)
}

export async function getOnboardingStatus() {
	return await getOnboardingStatusBase(resolveAgentDir, loadMemoryService)
}

export async function markOnboardingPrompted(trigger: string) {
	return await markOnboardingPromptedBase(resolveAgentDir, trigger)
}

export async function refreshOnboardingCompletion() {
	return await refreshOnboardingCompletionBase(resolveAgentDir, loadMemoryService)
}

export async function loadMemoryService() {
	const moduleUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'store.js')).href
	return await import(moduleUrl)
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
