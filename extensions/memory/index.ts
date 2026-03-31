import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

import {
	buildOnboardingPrompt,
	compilePromptMemory,
	executeMemoryTool,
	formatMemoryResult,
	markOnboardingPrompted,
	memoryToolParameters,
	refreshOnboardingCompletion,
} from './lib.js'

function stringifyMessageContent(content: any): string {
	if (typeof content === 'string') return content
	if (Array.isArray(content)) {
		return content
			.filter((part) => part?.type === 'text')
			.map((part) => String(part?.text || ''))
			.join('\n')
	}
	return ''
}

function sessionMeta(ctx: any) {
	return {
		sessionId: String(ctx?.sessionManager?.getSessionId?.() || '').trim(),
		sessionFile: String(ctx?.sessionManager?.getSessionFile?.() || '').trim(),
		cwd: String(ctx?.cwd || '').trim(),
		chatKey: String(ctx?.sessionManager?.getSessionName?.() || '').trim(),
	}
}

function triggerInitConversation(pi: ExtensionAPI, mode: 'auto' | 'manual') {
	pi.sendUserMessage(buildOnboardingPrompt(mode), { deliverAs: 'followUp' })
}

export default function memoryExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'rin_memory',
		label: 'Rin Memory',
		description: 'Manage the markdown-backed long-term memory library, event ledger, automatic consolidation, and context recall pipeline.',
		promptSnippet: 'Manage the markdown-backed long-term memory system with resident memory, progressive memory, recall memory, and event ledger processing.',
		promptGuidelines: [
			'Use `rin_memory` for long-term reusable memory, project recall, event history, and memory maintenance. Use it when you need to save, inspect, search, move, process, or review memory state.',
			'Resident memory is for short global always-on baselines. Progressive memory is for long-form global or directional guidance that should appear as an expandable entry. Recall memory is for everything that should only be remembered when needed.',
			'Prefer searching and then reading the relevant memory files instead of assuming recall/episode/history content has already been injected into the prompt. Resident and progressive index are the only prompt-resident layers.',
			'Before saving a new memory, search first and prefer updating, moving, or consolidating an existing memory instead of creating duplicates.',
		],
		parameters: memoryToolParameters,
		execute: async (_toolCallId, params) => {
			const action = String((params as any)?.action || '').trim()
			try {
				const response = await executeMemoryTool(params as any)
				return {
					content: [{ type: 'text', text: formatMemoryResult(action, response) }],
					details: response,
				}
			} catch (error: any) {
				return {
					content: [{ type: 'text', text: String(error?.message || error || 'memory_action_failed') }],
					details: { ok: false, error: String(error?.message || error || 'memory_action_failed') },
					isError: true,
				}
			}
		},
	})

	pi.on('input', async (event, ctx) => {
		const text = String(event?.text || '').trim()
		if (!text) return
		await executeMemoryTool({
			action: 'log_event',
			kind: 'user_input',
			text,
			summary: `user: ${text}`,
			source: `input:${String(event?.source || 'interactive')}`,
			...sessionMeta(ctx),
		})
		await executeMemoryTool({ action: 'process', sessionFile: sessionMeta(ctx).sessionFile })
	})

	pi.on('tool_execution_end', async (event, ctx) => {
		const text = stringifyMessageContent(event?.result?.content)
		await executeMemoryTool({
			action: 'log_event',
			kind: 'tool_result',
			text: text || JSON.stringify(event?.result?.details || {}, null, 2),
			summary: `${String(event?.toolName || 'tool')}${event?.isError ? ' (error)' : ''}: ${text || 'completed'}`,
			toolName: String(event?.toolName || ''),
			isError: Boolean(event?.isError),
			source: `tool:${String(event?.toolName || '')}`,
			...sessionMeta(ctx),
		})
	})

	pi.on('message_end', async (event, ctx) => {
		if (event?.message?.role !== 'assistant') return
		const text = stringifyMessageContent(event.message.content)
		if (!text) return
		await executeMemoryTool({
			action: 'log_event',
			kind: 'assistant_message',
			text,
			summary: `assistant: ${text}`,
			source: 'assistant:message_end',
			...sessionMeta(ctx),
		})
	})

	pi.on('agent_end', async (_event, ctx) => {
		await executeMemoryTool({ action: 'process', sessionFile: sessionMeta(ctx).sessionFile })
		await refreshOnboardingCompletion()
	})

	pi.registerCommand('init', {
		description: 'Start or restart memory onboarding conversation.',
		handler: async (_args, ctx) => {
			await markOnboardingPrompted('manual:/init')
			if (!ctx.isIdle()) {
				ctx.ui.notify('Memory onboarding queued.', 'info')
			}
			triggerInitConversation(pi, 'manual')
		},
	})

	pi.on('before_agent_start', async (event, ctx) => {
		await executeMemoryTool({ action: 'process', sessionFile: sessionMeta(ctx).sessionFile })
		const { systemPrompt } = await compilePromptMemory(String(event?.prompt || ''))
		if (!systemPrompt) return
		if (String(event.systemPrompt || '').includes(systemPrompt)) return
		return {
			systemPrompt: `${String(event.systemPrompt || '').trimEnd()}\n\n${systemPrompt}`.trimEnd(),
		}
	})
}
