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

## User-scoped launcher paths

Rin launchers are user-scoped, not global.

Typical launcher paths:

- `~/.local/bin/rin`
- `~/.local/bin/rin-install`

Important implications for the agent:

- do not assume the current local account always has a `rin` command in PATH
- the user who owns the launcher can differ from the daemon target user
- the account currently running the agent can also differ from both of the above
- when `rin` is missing, that does not by itself mean Rin is not installed

In other words, keep these roles separate:

- launcher-owning user
- daemon target user
- current local account running the agent

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
