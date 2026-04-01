# memory

Rin's builtin long-term memory extension.

The primary tool name is `memory`.
For compatibility with older prompts and integrations, `rin_memory` remains available as an alias for now.

Implementation note:

- the extension is extension-first
- semantic extraction and episode synthesis happen in extension modules
- `store.ts` is the storage/index backend
- `service.ts` is only a compatibility shim
- a future hybrid retrieval layer can be added without changing markdown as the source of truth

## What it now does

- registers the `memory` tool as the primary name
- keeps `rin_memory` as a compatibility alias
- stores memory under `~/.rin/memory/` (or the active agent dir)
- keeps three explicit layers:
  - `resident`: short always-on global baselines
  - `progressive`: long-form expandable global or directional memory, exposed as skill-like `name + desc` entries
  - `recall`: project/topic/history memory recalled only when needed
- maintains an append-only event ledger under `memory/events/`
- auto-processes new events for storage maintenance, chronicles, and graph refresh
- performs semantic memory extraction in the extension layer with the active agent model when a session is being shut down or when switching sessions with `/new`, then persists structured candidates through the memory store
- auto-maintains session chronicle recall docs from the event ledger
- auto-builds episode docs in the extension layer with the active agent model during session shutdown or `/new` session switch handoff, appending structured summaries into session-scoped recall history
- auto-builds a relation graph across active memory docs for low-cost associative recall
- auto-runs lifecycle reconciliation conservatively for storage/index maintenance without regex-driven semantic promotion across layers
- retrieval remains local and lightweight: markdown docs + frontmatter + event jsonl + lexical scoring + relation graph; no vector index is required today
- compiles per-turn prompt memory conservatively with:
  - resident memory
  - progressive memory index
- keeps richer compile/search outputs for active retrieval, but does not auto-inject recall / episode / related / history bodies into the system prompt

## Tool actions

`memory` supports:

- `list`
- `search`
- `save`
- `delete`
- `move`
- `compile`
- `doctor`
- `log_event`
- `events`
- `event_search`
- `process`

`memory.search` is the discovery entrypoint:
- it returns candidate ids, metadata, scores, and file paths
- it does not return full document bodies
- if full contents are needed, use the normal `read` tool on the returned path

## Notes

- resident slots remain restricted to:
  - `agent_identity`
  - `owner_identity`
  - `core_voice_style`
  - `core_methodology`
  - `core_values`
- event logging and local processing are automatic through extension hooks
- LLM-backed memory extraction / episode synthesis are no longer per-turn; they run on `session_shutdown` and on `session_switch` with `reason === "new"`
- progressive prompt exposure is intentionally skill-like: short index entry first
- includes an onboarding `/init` flow that can be used from any TUI or Koishi chat like a normal command
- `/init` keeps its internal onboarding instructions hidden from the user-facing chat transcript
- onboarding order is intentionally structured, but the agent should handle that order conversationally rather than through a rigid extension-side phase machine:
  - first establish the user's preferred language
  - then ask the user to define the assistant's own name / identity / relationship framing
  - then ask how to address the user
  - finally ask for the assistant's default voice/style preferences
- anything beyond those basics is intentionally open-ended and should be discovered naturally rather than forced by checklist
- repeated or corrected init content should supersede older memory rather than creating stale duplicates
