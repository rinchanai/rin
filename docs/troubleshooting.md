# Troubleshooting

This page is for common Rin repo and runtime troubleshooting cases.

## `rin` is missing

Do not immediately assume Rin is not installed.

Common cause:

- the current shell user is not the launcher-owning user

If `rin` still resolves on the current shell, start with:

```bash
rin doctor
```

If `rin` does not resolve at all, inspect the install metadata first instead of reinstalling blindly.

Useful places:

- `~/.config/rin/install.json`
- `<installDir>/installer.json`
- Linux user service: `~/.config/systemd/user/rin-daemon*.service`
- macOS launch agent: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

Direct runtime recovery shape:

```bash
node <installDir>/app/current/dist/app/rin/main.js doctor -u <targetUser>
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

Prefer recovering the real install path and target user before you rerun `install.sh`.

## Build fails because vendor artifacts are missing

Run the normal build order:

```bash
npm install
npm run build:vendor
npm run build:core
npm run build:extensions
```

Do not assume `build:core` or `build:extensions` can succeed before vendor artifacts exist.

## Tests fail after a structural refactor

Check whether the break is a real product regression or only a stale test semantic.

This repo has already had cases where old test language survived after the production concept was removed.

Examples:

- old detached blank session semantics in TUI tests
- stale adapter assumptions around runtime/session shape

## Koishi inbound media exists in storage but does not reach the agent

Inspect the route decision layer, not only persistence.

Typical questions:

- did the message contain real text, media, or both?
- did the bridge reject media-only input as empty text?
- did prompt restoration rebuild media payloads correctly?

Relevant areas:

- `src/core/rin-koishi/chat-helpers.ts`
- `src/core/rin-koishi/decision.ts`
- `src/core/rin-koishi/transport.ts`

## `search_memory` fails on archived transcript duplicates

This repo now tolerates duplicate archived transcript ids in search indexing.

If it breaks again, inspect:

- transcript archive sources
- archive backfill scripts
- search db build-time deduplication

Relevant area:

- `extensions/memory/transcripts.ts`

## `npm audit` still reports Koishi-related moderate findings

Current remaining findings are concentrated in the Koishi / Satori dependency chain.

Do not force semver-major churn into the default path blindly.

Check:

- `docs/security.md`
- `docs/dependency-upgrades.md`

## TUI settings look wrong before a remote session is attached

Check whether the issue is in:

- persistent settings hydration
- local UI state bootstrapping
- RPC-only mutation assumptions

Relevant areas:

- `src/core/rin-tui/settings-manager.ts`
- `src/core/rin-tui/settings-hydration.ts`
- `src/core/rin-tui/model-settings.ts`
- `src/core/rin-tui/runtime.ts`
