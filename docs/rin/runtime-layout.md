# Runtime Layout

Rin's agent working directory is usually `~/.rin/`.

## Top-level layout

- `auth.json`: model authentication data
- `settings.json`: Rin / pi settings
- `sessions/`: session data
- `memory/`: markdown-backed memory data
- `routines/`: routine prompts and task files
- `data/`: daemon, index, Koishi, web-search, and other runtime state
- `docs/rin/`: Rin-specific user docs for the agent
- `docs/pi/`: installed copies of upstream pi docs
- `app/current/`: the currently active runtime
- `app/releases/<timestamp>/`: runtime release directories

## `app/current/`

`app/current/` is the stable entrypoint for the currently active runtime.

For the agent, the important part is:

- treat it as the stable path for the current runtime version
- do not depend on a specific `app/releases/<timestamp>/...` path
- if you must reference read-only resources from the current runtime, prefer entering through `app/current/`

The contents behind it may be fully refreshed during updates.

## Stable vs unstable paths

Prefer these stable paths when possible:

- `~/.rin/docs/rin/...`
- `~/.rin/docs/pi/...`
- `~/.rin/settings.json`
- `~/.rin/auth.json`
- `~/.rin/sessions/...`
- `~/.rin/memory/...`
- `~/.rin/app/current/...`

Avoid baking a specific `app/releases/<timestamp>/...` path into long-lived configs or instructions.

## Documentation install policy

Rin-specific docs are installed into the stable `docs/rin/` path rather than a release-specific directory.
This lets the system prompt point to stable documentation paths across updates.
