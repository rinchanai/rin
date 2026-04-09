# self-improve

Rin's builtin self-improvement extension.

Public tool:

- `save_prompts`

## Responsibilities

This module owns:

- always-on prompt baselines under `~/.rin/self_improve/prompts`
- agent-managed reusable skills under `~/.rin/self_improve/skills`
- onboarding for resident self-improve prompts
- periodic review and pre-compaction self-improve review

It does not own session-history recall. That belongs to the `memory` extension.

## Prompt slots

- `agent_profile`
- `user_profile`
- `core_doctrine`
- `core_facts`

Current limit design is intentionally generous: profile slots are still smaller than facts, but all slots have enough room for real resident memory without becoming cramped.
