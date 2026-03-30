import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

import {
	compilePromptMemory,
	executeMemoryTool,
	formatMemoryResult,
	memoryToolParameters,
} from './lib.js'

export default function memoryExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'rin_memory',
		label: 'Rin Memory',
		description: 'Manage the markdown-backed long-term memory library. Prefer recall or progressive memory before resident; use recent session history when exact recent wording matters.',
		promptSnippet: 'Manage the markdown-backed long-term memory library.',
		promptGuidelines: [
			'Use `rin_memory` for long-term reusable memory, not for verbatim recent transcript; use session history when exact recent wording matters.',
			'Before calling `rin_memory` to save memory, search for an existing entry and prefer updating or replacing it instead of creating duplicates.',
			'When using `rin_memory`, prefer `recall` or `progressive` exposure before `resident`. Never create new resident slots; allowed slots are `agent_identity`, `owner_identity`, `core_voice_style`, `core_methodology`, and `core_values`.',
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

	pi.on('before_agent_start', async (event) => {
		const block = await compilePromptMemory()
		if (!block) return
		if (String(event.systemPrompt || '').includes(block)) return
		return {
			systemPrompt: `${String(event.systemPrompt || '').trimEnd()}\n\n${block}`.trimEnd(),
		}
	})
}
