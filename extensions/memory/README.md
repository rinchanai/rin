# memory

Rin's builtin session-history memory extension.

Public tool:

- `search_memory`

## Responsibilities

This module owns:

- transcript archiving under `~/.rin/memory/transcripts`
- cross-session transcript search

It does not own always-on prompts or agent-managed skills. Those belong to the `self-improve` extension.
