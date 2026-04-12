# Rin Architecture Overview

This is a short human-facing map of the project.

## Product shape

Rin is a local-first assistant organized around one entrypoint: `rin`.

The product is built from a few major layers:

1. app entrypoints
2. core runtime services
3. builtin extensions
4. installed runtime/docs layout under `~/.rin/`

## Main layers

### `src/app/`

Thin entrypoints for:

- `rin`
- `rin-daemon`
- `rin-tui`
- `rin-koishi`
- `rin-install`

These should stay light. Most behavior belongs in `src/core/`.

### `src/core/rin-tui/`

Owns the default interactive user path.

Responsibilities:

- frontend runtime behavior
- daemon connection and reconnect handling
- local UI state
- session attach/restore behavior

This is one of the most user-sensitive areas in the repo.

### `src/core/rin-daemon/`

Owns the background runtime and RPC surface.

Responsibilities:

- worker lifecycle
- session orchestration
- command execution
- shutdown and resume behavior
- RPC transport for the TUI

### `src/core/rin-koishi/`

Owns the chat bridge.

Responsibilities:

- inbound message normalization
- bridge prompt construction
- session binding
- outbound delivery and retries
- attachment persistence and restoration

### `src/core/rin-install/`

Owns install and update workflows.

Responsibilities:

- interactive install planning
- launcher and service setup
- install manifests
- release publishing and switching
- update flow

### `extensions/`

Rin-specific builtin capabilities.

Important examples:

- `extensions/memory/`
- `extensions/self-improve/`
- `extensions/subagent/`
- `extensions/task/`
- `extensions/web-search/`
- `extensions/fetch/`

## Upstream boundary

`third_party/pi-coding-agent/` is the carried upstream base.

Rin-owned product work should land in Rin-owned code first.
Avoid editing `third_party/` unless the task is explicitly an upstream-sync or upstream-fix task.

## Runtime model

At a high level:

1. the user launches `rin`
2. Rin prefers daemon + RPC TUI mode
3. the daemon owns the live session worker lifecycle
4. builtin extensions provide extra capabilities
5. persistent state lives under `~/.rin/`

## Stable paths

Prefer stable paths over release-stamped ones:

- `~/.rin/docs/rin/`
- `~/.rin/docs/pi/`
- `~/.rin/settings.json`
- `~/.rin/auth.json`
- `~/.rin/sessions/`
- `~/.rin/memory/`
- `~/.rin/app/current/`

## Engineering priorities

When tradeoffs appear, prefer:

- default-path reliability over feature breadth
- clean boundaries over fallback stacks
- explicit state over hidden inference
- testable modules over oversized god files
- user-facing docs separated from agent-facing docs
