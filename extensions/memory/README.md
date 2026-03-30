# memory

Injects Rin's markdown-backed long-term memory as a builtin extension.

## What it does

- registers the `rin_memory` tool
- stores memories under `~/.rin/memory/` (or the active agent dir)
- compiles resident and progressive memory into the per-turn system prompt
- keeps the old markdown document format, resident slots, and action surface

## Notes

- vector search is opportunistic: if LanceDB / transformers dependencies are unavailable, search falls back to lexical matching and reports vector status in `details`
- resident slots remain restricted to:
  - `agent_identity`
  - `owner_identity`
  - `core_voice_style`
  - `core_methodology`
  - `core_values`
