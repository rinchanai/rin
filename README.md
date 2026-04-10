[English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md)

# Rin

A terminal-first local AI assistant that can chat, edit files, remember things, search the web, and run scheduled tasks.

## What Rin is

Rin is for people who want more than a one-shot coding agent.

It is a local assistant you can keep around in your terminal for day-to-day work:

- ask questions in plain language
- inspect and modify files
- keep useful long-term memory
- set reminders and recurring tasks
- look up fresh information on the web
- bridge the same assistant into chat platforms through Koishi

The goal is simple: make the agent feel like a tool you can actually live with, not just a shell around a model.

## Why Rin

Rin focuses on a few basics:

- terminal-first workflow
- built-in memory, not just stateless chats
- built-in scheduled tasks
- built-in web search for time-sensitive questions
- chat bridge support through Koishi
- one product entrypoint: `rin`

If you want an assistant that stays useful over time, Rin is designed for that.

## Quick start

Install:

```bash
./install.sh
```

Then open Rin:

```bash
rin
```

Check health if needed:

```bash
rin doctor
```

The installer will warn you about security boundaries and possible extra token usage. That can include initialization, memory processing, summarization, subagents, scheduled tasks, and web search.

## What you can ask Rin to do

Once Rin is open, you can just talk to it.

Examples:

- `Look through this directory and tell me what matters.`
- `Rewrite this README.`
- `Clean up this config file.`
- `Remember that I prefer short answers.`
- `Remind me tomorrow afternoon to check the logs.`
- `Check the latest official docs for this tool.`
- `Watch this folder every hour and tell me if something changes.`

## Core commands

```bash
rin            # open Rin
rin doctor     # inspect health and configuration
rin start      # start the daemon
rin stop       # stop the daemon
rin restart    # restart the daemon
rin update     # update the installed Rin core runtime
```

## Updating Rin

For a normal installed Rin update, use:

```bash
rin update
```

If `rin` is missing on the current account, check these in order:

```bash
command -v rin
~/.local/bin/rin update
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

Find `<installDir>` and `<targetUser>` from the install metadata or managed service files:

- Linux: `~/.config/rin/install.json`
- macOS: `~/Library/Application Support/rin/install.json`
- target manifest: `<installDir>/installer.json`
- Linux service: `~/.config/systemd/user/rin-daemon*.service`
- macOS service: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

This is the canonical update path for the installed runtime.
It refreshes the core runtime and installed docs.
It does not replace the user-scoped CLI launcher or installer.

Avoid treating repo-local workflows like `git pull`, ad-hoc rebuilds, or rerunning `install.sh` as the default way to update an already installed Rin.

## Key built-in capabilities

Rin comes with a few things wired in by default:

- long-term memory
- scheduled tasks and reminders
- live web search
- Koishi chat bridge
- subagents for delegated work

## When to use `rin --std`

Normally, use `rin`.

`rin --std` is mainly a troubleshooting fallback when the default RPC mode has problems and you need a foreground session to recover or debug.

## Docs

If you want more detail, start here:

- [`docs/rin/README.md`](docs/rin/README.md)
- [`docs/rin/docs/capabilities.md`](docs/rin/docs/capabilities.md)
- [`docs/rin/docs/runtime-layout.md`](docs/rin/docs/runtime-layout.md)
- [`docs/rin/docs/builtin-extensions.md`](docs/rin/docs/builtin-extensions.md)

## Short version

Install it, run `rin`, and ask for what you need.

That is the main idea.
