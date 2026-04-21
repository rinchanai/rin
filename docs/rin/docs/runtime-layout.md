# Runtime Layout

Rin's agent working directory is usually `~/.rin/`.

## Top-level layout

- `auth.json`: model authentication data
- `settings.json`: Rin / pi settings
- `sessions/`: session data; canonical live session files are discovered directly from this root, while nested legacy subdirectories are residue to clean up rather than active sources
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

- Linux / macOS: `~/.local/bin/rin`
- Linux / macOS: `~/.local/bin/rin-install`
- Windows: `~/AppData/Roaming/npm/rin.cmd`
- Windows: `~/AppData/Roaming/npm/rin-install.cmd`

Launcher metadata is also user-scoped.

Typical metadata paths:

- Linux: `~/.config/rin/install.json`
- macOS: `~/Library/Application Support/rin/install.json`
- Windows: `~/AppData/Roaming/rin/install.json`

This metadata records the current user's default `targetUser` and `installDir`.
It is useful only when you are operating as the same user who owns the launcher.
It is also a fallback discovery source for `rin update` when the launcher-owning account is available but managed service files or install manifests are missing.
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
- `<targetHome>/.rin/installer.json`: stable locator manifest under the target home; for custom install dirs it points to the real `installDir`
- Windows launcher metadata: `~/AppData/Roaming/rin/install.json`
- Linux user service: `~/.config/systemd/user/rin-daemon*.service`
- macOS launch agent: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

These files are the main way to recover `installDir` and `targetUser` when the current account does not have a working `rin` command.
Service files expose the runtime directory through `RIN_DIR`, and once `installDir` is known the next stop should be `<installDir>/installer.json`.

## Installed update recovery path

Keep `rin update` as the canonical workflow when the current account already has a working launcher.

If `rin` is missing on the current account, treat that as a launcher-placement clue rather than as evidence that Rin is not installed.
In that case, prefer this recovery order:

1. find `installDir` from a managed service file or a known target home
2. open `<installDir>/installer.json` to confirm `targetUser`
3. invoke the stable installed runtime entry directly:
   - `node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>`

Typical places to recover `installDir`:

- `<targetHome>/.rin/installer.json`
- Windows: `~/AppData/Roaming/rin/install.json`
- Linux: `~/.config/systemd/user/rin-daemon*.service`
- macOS: `~/Library/LaunchAgents/com.rin.daemon.*.plist`
- default target-home install directory: `<targetHome>/.rin/`

This keeps installed-runtime maintenance separate from repo-checkout maintenance.
Do not treat rerunning `install.sh`, ad-hoc rebuilds, or repo-local `git pull` workflows as the normal way to update an already installed Rin runtime.

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
