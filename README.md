[English](README.md) | [Chinese](README.zh-CN.md) | [Japanese](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md)

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
- bridge the same assistant into chat platforms through a chat bridge

The goal is simple: make the agent feel like a tool you can actually live with, not just a shell around a model.

## Why Rin

Rin focuses on a few basics:

- terminal-first workflow
- built-in memory, not just stateless chats
- built-in scheduled tasks
- built-in web search for time-sensitive questions
- built-in chat bridge support
- one product entrypoint: `rin`

If you want an assistant that stays useful over time, Rin is designed for that.

## Quick start

Install with one command, no clone required:

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/main/scripts/bootstrap-entrypoint.sh | sh -s install
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/main/scripts/bootstrap-entrypoint.sh | sh -s install --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/main/scripts/bootstrap-entrypoint.sh | sh -s install --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/main/scripts/bootstrap-entrypoint.sh | sh -s install --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/main/scripts/bootstrap-entrypoint.sh | sh -s install --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/main/scripts/bootstrap-entrypoint.sh | sh -s install --git deadbeef
```

If you already have the repo locally, the bundled wrapper scripts do the same bootstrap flow:

```bash
./install.sh              # stable release (default)
./install.sh --beta       # current weekly beta candidate
./install.sh --nightly    # current nightly build
./install.sh --git        # main
./install.sh --git main
./install.sh --git deadbeef
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
rin update              # stable release (default)
rin update --beta       # current weekly beta candidate
rin update --nightly    # current nightly build
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

If `rin` is confirmed missing on the current account, treat that as “this is not the launcher-owning user”.
In that case, recover the real target install through the installed metadata described in `docs/rin/docs/runtime-layout.md`:

- `<targetHome>/.rin/installer.json`
- Linux: `~/.config/systemd/user/rin-daemon*.service`
- macOS: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

Then invoke the stable installed runtime entry directly:

```bash
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

This is the canonical update path for the installed runtime.
It refreshes the core runtime and installed docs.
It does not replace the user-scoped CLI launcher or installer.

Important release-channel rule:
- stable is the default for install and update
- `--beta` means the current weekly beta candidate
- `--nightly` means the current nightly build from `main`
- `--git` with no suffix means `main`

Avoid treating repo-local workflows like `git pull`, ad-hoc rebuilds, or rerunning `install.sh` as the default way to update an already installed Rin.

## Key built-in capabilities

Rin comes with a few things wired in by default:

- long-term memory
- scheduled tasks and reminders
- live web search
- chat bridge coverage for Telegram, OneBot, Discord, Kook, QQ, Lark, Mail, WeChat Official, WeCom, DingTalk, Matrix, WhatsApp, LINE, Slack, and Zulip
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
- [`docs/rin/docs/release-trains.md`](docs/rin/docs/release-trains.md)
- [`docs/rin/docs/releasing.md`](docs/rin/docs/releasing.md)
- [`docs/rin/docs/first-stable-release-checklist.md`](docs/rin/docs/first-stable-release-checklist.md)
- [`upstream/pi/README.md`](upstream/pi/README.md) for the tracked upstream Pi mirror used by Rin
- [`upstream/skill-creator/SKILL.md`](upstream/skill-creator/SKILL.md) for the tracked upstream builtin skill mirror used by Rin

Refresh the mirrored upstream assets when needed:

```bash
npm run sync:upstreams
```

You can also refresh one mirror at a time:

```bash
npm run sync:pi-docs
npm run sync:skill-creator
```

## Short version

Install it, run `rin`, and ask for what you need.

That is the main idea.
