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

The updater uses these same sources to discover installed targets. If `rin update` shows more than one candidate, verify which launcher-owning home and install dir you actually want before proceeding.

Direct runtime recovery shape:

```bash
node <installDir>/app/current/dist/app/rin/main.js doctor -u <targetUser>
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

Prefer recovering the real install path and target user before you rerun `install.sh`.

If the installer or updater seems to have written the wrong defaults, inspect the stable state files directly:

- `<installDir>/installer.json` for target/install metadata
- `<installDir>/settings.json` for provider/model/thinking defaults and Koishi config
- `<installDir>/auth.json` for saved auth material
- `~/.config/rin/install.json` for the current user's launcher defaults

## `rin update` finished but the current shell still behaves oddly

Remember what `rin update` does and does not do.

It refreshes the installed core runtime, but it does not rewrite every possible shell environment or ad-hoc launcher state.

Check:

- whether the current shell is using the launcher-owning user
- whether the updater selected the intended installed target when multiple candidates exist
- whether the runtime symlink moved to a fresh release under `<installDir>/app/current`
- whether you are calling the stable launcher or an old direct path

Useful commands:

```bash
rin --help
rin doctor
rin restart
rin --tmux-list
readlink -f <installDir>/app/current
node <installDir>/app/current/dist/app/rin/main.js doctor -u <targetUser>
```

Use `rin restart` when the managed daemon unit exists but the runtime feels stale or wedged. If no managed service is present, Rin falls back to the direct stop/start daemon path for the target install.

Use `rin --tmux-list` if you expect a long-lived hidden Rin tmux session to still exist but you have lost track of its name from the current shell.

If the refreshed runtime works through the direct stable entry but not through your current shell path, debug the launcher/user context before assuming the update failed.

## Provider auth or installer prompts behave differently than expected

Check which branch of the interactive installer actually ran:

- existing auth already present in `<installDir>/auth.json`
- OAuth provider flow
- plain API key/token entry flow
- provider selected but no models available in the current runtime build

If the prompt sequence feels wrong, inspect:

- `src/core/rin-install/interactive.ts`
- `src/core/rin-install/provider-auth.ts`
- `src/core/rin-install/persist.ts`

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
