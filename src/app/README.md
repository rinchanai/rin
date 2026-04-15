# app

This directory is the product assembly layer.

It intentionally contains only thin executable entrypoints and builtin-extension wiring.

## Responsibilities

- keep `src/core/` independently runnable and free of app-specific policy
- define which standard extensions are force-loaded by the app build
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
So the app build cannot ask core entrypoints to know about app profiles or builtin extensions.
Instead, app provides a few very small wrappers that only do assembly:

- `builtin-extensions.ts` defines the app's forced builtin extensions
- `rin-daemon/daemon.ts` points the daemon at the app worker
- `rin-daemon/worker.ts` starts the core worker with builtin extension paths
- `rin-tui/main.ts` starts the shared TUI launcher with builtin extension paths
- `rin-chat/main.ts` starts the shared Chat bridge with builtin extension paths
