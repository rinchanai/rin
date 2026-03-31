# rin-project-docs

Adds stable Rin and pi documentation paths to the system prompt during `before_agent_start`.

## Behavior

- uses `docs/rin/*.md` and `docs/pi/*` under `PI_CODING_AGENT_DIR` / `RIN_DIR`
- uses repository docs when installed docs are not present
- avoids duplicate prompt injection

## Load order

Load this before `freeze-session-runtime`.
