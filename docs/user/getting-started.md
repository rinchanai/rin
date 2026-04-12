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

- downloads the current repo source archive
- rebuilds the core runtime
- publishes a fresh release under `<installDir>/app/releases/...`
- repoints `<installDir>/app/current` to that new release

Do not treat repo-local `git pull`, ad-hoc rebuilds, or rerunning `install.sh` as the standard way to update an already installed runtime.

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
rin doctor
rin start
rin stop
rin restart
rin update
```

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
