# memory

Rin's builtin session-history memory extension.

Public tool:

- `search_memory` — query past sessions, or leave `query` empty to browse recent sessions directly

## Responsibilities

This module owns:

- transcript archiving under `~/.rin/memory/transcripts`
- cross-session transcript search
- transcript recall summarization via the current model by default, or `settings.json` -> `auxiliaryModel` when configured

It does not own always-on prompts or agent-managed skills. Those belong to the `self-improve` extension.
