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

- `agent_profile`: the assistant's own stable identity, relationship framing, tone, and recurring behavior style
- `user_profile`: stable knowledge about the user and how to address them
- `core_doctrine`: standing methods, priorities, values, and decision rules
- `core_facts`: durable external facts, environment facts, project conventions, and preferences that are not the user's identity

Prompt slots are identified directly by filename under `~/.rin/self_improve/prompts/`.
For example, `~/.rin/self_improve/prompts/agent_profile.md` is the `agent_profile` slot.
These prompt files are stored as markdown list items.
Read-before-write is required: first call `save_prompts` with only `slot` to get the current canonical content and usage, then submit the full revised content with `baseContent` from that read.
Treat the returned content as canonical: pass `baseContent` exactly as read, and prefer keeping `content` in that same normalized shape unless you intentionally want the tool to re-normalize it.
When new durable information overlaps an existing slot, rewrite the full slot with merged, deduplicated, up-to-date lines instead of appending partial fragments or leaving stale lines behind.

Current limit design is intentionally generous: profile slots are still smaller than facts, but all slots have enough room for real resident memory without becoming cramped.
