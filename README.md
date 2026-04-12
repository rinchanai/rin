[English](README.md) | [Chinese](README.zh-CN.md) | [Japanese](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md)

# Rin

Rin is a terminal-first local AI assistant that stays useful between turns.

It can chat, edit files, remember durable preferences, search the web, run scheduled tasks, and bridge into chat platforms through Koishi — all behind one entrypoint: `rin`.

## What Rin is for

Rin is built for people who want an assistant they can keep around for daily work instead of reopening a fresh one-shot agent every time.

Use it when you want to:

- inspect and modify a codebase from the terminal
- keep stable memory and reusable skills
- schedule reminders and recurring checks
- look up fresh information without leaving the workflow
- continue the same assistant from terminal and chat

## Current project status

Rin is already usable, but it is still an actively refined product.

The core direction is stable:

- local-first workflow
- built-in memory and recall
- built-in scheduled tasks
- built-in web search and fetch
- Koishi bridge support
- one consistent runtime and update path

But the project is still being polished in reliability, UX, and docs. If you try it today, expect a moving product rather than a frozen platform.

## Quick start

Install:

```bash
./install.sh
```

Open Rin:

```bash
rin
```

Check health if needed:

```bash
rin doctor
```

## Core commands

```bash
rin            # open Rin
rin doctor     # inspect health and configuration
rin start      # start the daemon
rin stop       # stop the daemon
rin restart    # restart the daemon
rin update     # update the installed Rin runtime
```

## What you can ask Rin to do

Examples:

- `Look through this directory and tell me what matters.`
- `Rewrite this README.`
- `Clean up this config file.`
- `Remember that I prefer short answers.`
- `Remind me tomorrow afternoon to check the logs.`
- `Check the latest official docs for this tool.`
- `Watch this folder every hour and tell me if something changes.`

## Built-in capabilities

Rin ships with a few capabilities wired in by default:

- long-term memory and recall
- scheduled tasks and reminders
- live web search
- direct URL fetch
- subagents
- Koishi chat bridge

## Updating Rin

For a normal installed runtime, use:

```bash
rin update
```

If `rin` is missing on the current account, do not assume Rin is absent. It usually means the current shell user is not the launcher-owning user.

For the full recovery/update workflow, see:

- [`docs/user/getting-started.md`](docs/user/getting-started.md)
- [`docs/development.md`](docs/development.md)

## Documentation

User-facing docs:

- [`docs/user/getting-started.md`](docs/user/getting-started.md)
- [`docs/development.md`](docs/development.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`docs/architecture.md`](docs/architecture.md)
- [`docs/security.md`](docs/security.md)
- [`docs/roadmap.md`](docs/roadmap.md)
- [`docs/troubleshooting.md`](docs/troubleshooting.md)
- [`docs/dependency-upgrades.md`](docs/dependency-upgrades.md)

Agent/runtime docs:

- [`docs/rin/README.md`](docs/rin/README.md)
- [`docs/rin/docs/capabilities.md`](docs/rin/docs/capabilities.md)
- [`docs/rin/docs/runtime-layout.md`](docs/rin/docs/runtime-layout.md)
- [`docs/rin/docs/builtin-extensions.md`](docs/rin/docs/builtin-extensions.md)

## Short version

Install it, run `rin`, and keep the assistant around.

That is the whole point.
