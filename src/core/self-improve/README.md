# self-improve

Rin's builtin self-improvement extension.

Public tool:

- `save_prompts`

## Responsibilities

This module owns:

- always-on prompt baselines under `~/.rin/self_improve/prompts`
- agent-managed reusable skills under `~/.rin/self_improve/skills`
- onboarding for resident self-improve prompts
- periodic review and pre-compaction self-improve review, both running at fixed `low` thinking

It does not own session-history recall. That belongs to the `memory` extension.

## Prompt slots

- `agent_profile`
- `user_profile`
- `core_doctrine`
- `core_facts`

`agent_profile` stores Rin's stable role, tone, behavior style, and standing expectations for how Rin should generally respond. `user_profile` stores the user's identity knowledge. `core_doctrine` stores durable methodology, worldview, and values. `core_facts` stores durable external facts, environment facts, user preferences, and operating conventions.

Prompt slots are identified directly by filename under `~/.rin/self_improve/prompts/`.
For example, `~/.rin/self_improve/prompts/agent_profile.md` is the `agent_profile` slot.
These prompt files are stored as markdown list items.
Read-before-write is required: first call `save_prompts` with only `slot` to get the current canonical content and usage, then submit the full revised content with `baseContent` from that read.
Treat the returned content as canonical: pass `baseContent` exactly as read, and prefer keeping `content` in that same normalized shape unless you intentionally want the tool to re-normalize it.

Current limit design keeps resident memory deliberately tight: `agent_profile` 8 lines, `user_profile` 4 lines, `core_doctrine` 16 lines, and `core_facts` 32 lines.
