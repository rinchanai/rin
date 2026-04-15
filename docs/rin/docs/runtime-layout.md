# Runtime Layout

Rin's agent working directory is usually `~/.rin/`.

## Top-level layout

- `auth.json`: model authentication data
- `settings.json`: Rin / pi settings
- `sessions/`: session data
- `memory/`: markdown-backed memory data
- `routines/`: routine prompts and task files
- `data/`: daemon, index, chat bridge, web-search, and other runtime state
  - custom chat bridge / Chat adapter packages, when used, are installed here via the generated runtime `package.json`
- `docs/rin/`: Rin-specific user docs for the agent
- `docs/pi/`: installed copies of upstream pi docs
- `app/current/`: the currently active runtime
- `app/releases/<timestamp>/`: runtime release directories

## User-scoped launcher paths

Rin launchers are user-scoped, not global.

Typical launcher paths:

- `~/.local/bin/rin`
- `~/.local/bin/rin-install`

Launcher metadata is also user-scoped.

Typical metadata paths:

- Linux: `~/.config/rin/install.json`
- macOS: `~/Library/Application Support/rin/install.json`

This metadata records the current user's default `targetUser` and `installDir`.
It is useful only when you are operating as the same user who owns the launcher.
If the current account already has no `rin` command, prefer jumping to the target install manifest workflow instead of inspecting the current account's launcher metadata.

Important implications for the agent:

- do not assume the current local account always has a `rin` command in PATH
- the user who owns the launcher can differ from the daemon target user
- the account currently running the agent can also differ from both of the above
- the current local account may be only an execution account rather than the interactive account that owns the launcher
- when `rin` is missing on the current account, that can be normal and does not by itself mean Rin is not installed

In other words, keep these roles separate:

- launcher-owning interactive user
- daemon target user
- current local account running the agent

## Install manifests and service files

Besides launchers, Rin exposes install ownership through stable metadata and managed service files.

Useful locations:

- `<installDir>/installer.json`: install manifest written into the target runtime directory
- Linux user service: `~/.config/systemd/user/rin-daemon*.service`
- macOS launch agent: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

These files are the main way to recover `installDir` and `targetUser` when the current account does not have a working `rin` command.
Service files expose the runtime directory through `RIN_DIR`, and once `installDir` is known the next stop should be `<installDir>/installer.json`.

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
