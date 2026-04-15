# Rin Getting Started

This guide is for people using Rin, not for agent-internal runtime behavior.

## Install

From the repo root:

```bash
./install.sh
```

The installer will:

- fetch the current `main` branch
- install dependencies
- build the runtime
- launch the interactive installer

Useful bootstrap overrides when you need a mirror or a controlled temp location:

```bash
RIN_INSTALL_REPO_URL=https://github.com/rinchanai/rin ./install.sh
RIN_INSTALL_TMPDIR=/tmp/rin-install ./install.sh
```

If bootstrap fails before the interactive installer appears, check the temporary `install.log` under `${RIN_INSTALL_TMPDIR:-${XDG_CACHE_HOME:-~/.cache}/rin-install}` before rerunning.

The interactive installer then walks through:

- target daemon user and install directory
- provider/model/thinking-level defaults
- provider auth when needed
- optional Koishi adapter setup
- final privilege/service requirements before files are written

Keep this distinction in mind during install and update:

- the selected daemon user owns the target runtime, config, and managed service files
- the current shell user still gets the launcher metadata and `rin` / `rin-install` launchers
- the installer may still need `sudo` / `doas` even when the install dir looks writable, because cross-user target metadata and managed service actions are privilege-sensitive

## Open Rin

```bash
rin
```

Normal usage should prefer `rin`.

Use `rin --std` mainly for troubleshooting when the default daemon/RPC path is unhealthy and you need a foreground session.

## Check health

```bash
rin doctor
```

Useful when:

- models are not available
- the daemon is not responding
- an update or install feels incomplete
- chat bridge behavior looks wrong

## Update

Normal installed update path:

```bash
rin update
```

What this does in practice:

- discovers installed Rin targets from `installer.json` and managed service files
- prompts for a target when more than one installed runtime is present
- downloads the current repo source archive
- rebuilds the core runtime
- publishes a fresh release under `<installDir>/app/releases/...`
- repoints `<installDir>/app/current` to that new release
- refreshes current-user launcher metadata and managed service files for the selected target
- may still need `sudo` / `doas` for cross-user target metadata or managed service actions even when the install dir already exists
- prunes older runtime releases and keeps only a small recent set

Do not treat repo-local `git pull`, ad-hoc rebuilds, or rerunning `install.sh` as the standard way to update an already installed runtime.

When you need to inspect an installed runtime directly, prefer the stable `app/current` path instead of a timestamped `app/releases/...` path.

A normal install or update refreshes the same stable state surfaces:

- `<installDir>/installer.json`
- `<installDir>/settings.json`
- `<installDir>/auth.json`
- `<installDir>/app/current`
- installed runtime docs under `<installDir>/docs/rin` and `<installDir>/docs/pi`
- the current-user launcher metadata under `~/.config/rin/install.json`
- managed launcher files such as `~/.local/bin/rin`

## If `rin` is missing

That usually means the current shell user is not the launcher-owning user.

Recovery path:

1. find the real install directory from the managed service file or known target home
2. read `<installDir>/installer.json`
3. run the stable runtime entry directly

Example shape:

```bash
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

Useful places to inspect:

- Linux service: `~/.config/systemd/user/rin-daemon*.service`
- macOS launch agent: `~/Library/LaunchAgents/com.rin.daemon.*.plist`
- install manifest: `<installDir>/installer.json`

## Core commands

```bash
rin
rin --help
rin doctor
rin start
rin stop
rin restart
rin update
rin usage
rin usage --help
```

Command intent:

- `rin doctor`: inspect the target install, socket, daemon workers, web-search runtime, and Koishi runtime state
- `rin start`: ensure the target daemon is available
- `rin stop`: stop the managed daemon when possible, otherwise fall back to the local daemon process pattern
- `rin restart`: restart the managed daemon or perform the same stop/start fallback pair
- `rin usage`: inspect token telemetry with a text dashboard, grouped summaries, or raw recent events

## Persistent tmux sessions

```bash
rin --tmux work
rin --tmux-list
```

Use hidden tmux sessions when you want a long-lived terminal entrypoint that you can reattach later without keeping the current shell open.

## Inspect usage telemetry

```bash
rin usage
rin usage --group-by provider_model,capability --from 7d
rin usage --events --limit 20
```

Use this after installation or model changes when you want a quick view of which models, sessions, or capabilities are consuming tokens.

## What Rin can do

- chat in the terminal
- inspect and edit files
- persist useful memory and recall it later
- run scheduled tasks
- search the web and fetch pages
- bridge into chat platforms through Koishi

## Useful in-session commands

Inside Rin, a few built-in slash commands are especially useful for day-to-day control:

```text
/changelog                 show recent shipped changes
/resume                    list resumable sessions
/resume <session-id>       switch back into a session
/model                     list available models
/model <provider/model>    switch model
/model <provider/model> high
/compact <instruction>     compact the current session with a focus
/reload                    reload extensions, prompts, skills, and themes
/session                   show current session stats
```

Use these for quick operator control without leaving the current session.

## More docs

User-facing docs:

- project overview: [`../../README.md`](../../README.md)
- changelog: [`../../CHANGELOG.md`](../../CHANGELOG.md)
- troubleshooting: [`../troubleshooting.md`](../troubleshooting.md)
- roadmap: [`../roadmap.md`](../roadmap.md)

Contributor docs:

- development notes: [`../development.md`](../development.md)
- contributing guide: [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md)
- architecture: [`../architecture.md`](../architecture.md)
- release management: [`../release-management.md`](../release-management.md)

Agent/runtime docs:

- [`../rin/README.md`](../rin/README.md)
