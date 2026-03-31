# memory

Rin's builtin long-term memory extension.

## What it now does

- registers the `rin_memory` tool
- stores memory under `~/.rin/memory/` (or the active agent dir)
- keeps three explicit layers:
  - `resident`: short always-on global baselines
  - `progressive`: long-form expandable global or directional memory, exposed as skill-like `name + desc` entries
  - `recall`: project/topic/history memory recalled only when needed
- maintains an append-only event ledger under `memory/events/`
- auto-processes new events into:
  - resident memories for short global methodology / voice / value cues
  - progressive memories for long-form domain-wide working preferences
  - recall memories for project-specific context
- auto-maintains session chronicle recall docs from the event ledger
- auto-builds independent episode docs from the event ledger with structured summaries, emerging preferences, decisions, files, open threads, and timelines
- auto-builds a relation graph across active memory docs for low-cost associative recall
- auto-runs lifecycle reconciliation, including observation counts, replacement-aware updates, and promotion from weaker layers when repeated evidence accumulates
- compiles per-turn prompt memory conservatively with:
  - resident memory
  - progressive memory index
- keeps richer compile/search outputs for active retrieval, but does not auto-inject recall / episode / related / history bodies into the system prompt

## Tool actions

`rin_memory` supports:

- `list`
- `search`
- `get`
- `save`
- `delete`
- `move`
- `compile`
- `doctor`
- `log_event`
- `events`
- `event_search`
- `process`

## Notes

- resident slots remain restricted to:
  - `agent_identity`
  - `owner_identity`
  - `core_voice_style`
  - `core_methodology`
  - `core_values`
- event logging and processing are automatic through extension hooks
- progressive prompt exposure is intentionally skill-like: short index entry first
- includes an onboarding `/init` flow that can be used from any TUI or Koishi chat like a normal command
- `/init` is intentionally lightweight: it must establish three basics early, then continue naturally through ordinary chat
- the three required basics are:
  - how to address the user
  - relationship / identity framing
  - language / tone / style
- anything beyond those three is intentionally open-ended and should be discovered naturally rather than forced by checklist
- repeated or corrected init content should supersede older memory rather than creating stale duplicates
