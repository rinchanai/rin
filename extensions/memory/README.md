# memory

Rin's builtin session-history memory extension.

Public tool:

- `search_memory` — query past sessions, or leave `query` empty to browse recent sessions directly

## Responsibilities

This module owns:

- transcript archiving under `~/.rin/memory/transcripts`
- archived session records preserve full message history for recall, including assistant thinking text, tool calls, tool results, and other text-bearing message roles
- high-signal task-anchor rows are derived from actionable transcript events to mark blockers, completed steps, and likely next actions
- session recall also derives a deterministic task-state summary from anchors or raw transcript rows when anchors are missing
- recent-session previews favor actionable entries such as assistant steps, task anchors, task-state summaries, tool activity, commands, paths, and unresolved blockers instead of generic chatter
- cross-session transcript search
- transcript recall summarization via the current model by default, or `settings.json` -> `auxiliaryModel` when configured
- recall summaries are steered to surface user goal, key steps, concrete tool activity, outcomes, and open threads

It does not own always-on prompts or agent-managed skills. Those belong to the `self-improve` extension.
