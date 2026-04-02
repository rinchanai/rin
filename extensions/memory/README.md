# memory

Rin's builtin long-term memory extension.

The memory tools are `search_memory` and `save_memory`.

Implementation note:

- the extension is extension-first
- markdown is the source of truth
- `store.ts` is the storage/index backend
- `service.ts` is only a compatibility shim
- the design stays intentionally simple: write good memory docs, search them well, and let a low-frequency LLM memory maintainer improve the library directly

## What it now does

- registers `search_memory` and `save_memory`
- stores memory under `~/.rin/memory/` (or the active agent dir)
- keeps three explicit layers:
  - `resident`: short always-on global baselines
  - `progressive`: important guidance exposed gradually
  - `recall`: project/topic/history memory searched only when needed
- keeps the public tool surface small:
  - `search`
  - `save`
  - `list`
- runs a low-frequency LLM memory maintainer when a session is being shut down or when switching sessions with `/new`
- includes a low-frequency `memory-consolidate` command that runs the same maintainer in cleanup mode for deduplication, rewrite, and invalidation of stale memory
- compiles prompt memory conservatively with:
  - resident memory
  - progressive memory index
- keeps retrieval local and lightweight with markdown frontmatter plus lexical search over title, tags, aliases, triggers, summary, and body

## Tools

The public memory tools are:

- `search_memory`
- `save_memory`

`search_memory` is the discovery entrypoint:

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
- automatic memory maintenance is low-frequency rather than per-message: it runs on `session_shutdown` and on `session_switch` with `reason === "new"`
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
