# app

This directory is the product assembly layer.

It intentionally contains only thin executable entrypoints and product-shell wiring.

## Responsibilities

- keep `src/core/` independently runnable and free of app-specific policy
- provide app-specific executable entrypoints for:
  - daemon
  - worker
  - TUI
  - Chat

## Non-goals

- no RPC protocol logic
- no session/runtime business logic
- no duplicate implementation of core features

Those belong in `src/core/`.

## Why there are still a few files here

Because `core` must remain independently runnable.
The app build still provides a few very small wrappers that only do product assembly:

- `rin-daemon/daemon.ts` points the daemon at the app worker
- `rin-daemon/worker.ts` starts the shared core worker
- `rin-tui/main.ts` starts the shared TUI launcher
- `rin-chat/main.ts` starts the shared Chat bridge

Builtin Rin capabilities are now owned and registered from `src/core/`.
