# Rin Development Notes

This document is for humans working on the Rin codebase.

## Repo shape

Main areas:

- `src/app/`: CLI entrypoints
- `src/core/`: runtime, daemon, TUI, installer, Koishi bridge, shared services
- `extensions/`: Rin builtin extensions
- `tests/`: Node test suite
- `docs/rin/`: agent-facing runtime docs installed with Rin
- `third_party/pi-coding-agent/`: upstream base carried in-tree

## Core product surfaces

Highest-risk user surfaces:

- `src/core/rin-tui/`: default interactive path
- `src/core/rin-daemon/`: daemon, RPC, worker lifecycle
- `src/core/rin-koishi/`: chat bridge and delivery pipeline
- `extensions/memory/`: transcript archiving and recall
- `src/core/rin-install/`: install and update path

When in doubt, stabilize these before adding feature breadth.

## Build

```bash
npm install
npm run build:vendor
npm run build:core
npm run build:extensions
```

Or all at once:

```bash
npm run build
```

## Test

```bash
node --test tests/*.test.mjs extensions/memory/memory.test.mjs extensions/self-improve/self-improve.test.mjs
```

## Quality gates

```bash
npm run lint
npm run format:check
```

Expected bar for mainline work:

- build green
- test green
- lint green
- format green

## Engineering stance

Rin should prefer:

- small explicit boundaries
- deterministic behavior over layered fallback stacks
- stable runtime paths under `~/.rin/...`
- repo fixes in Rin-owned code instead of patching runtime state by hand
- short direct product copy over inflated explanation

For installer and distribution work, treat these as stable operator-facing contracts unless there is an explicit product decision to change them:

- launcher scripts resolve through `app/current/...` rather than timestamped release paths
- installed runtime docs land under `docs/rin` and `docs/pi`
- user launchers and launcher metadata stay under the launcher-owning user's normal home/config locations, while the target runtime state stays under the selected install dir
- update flow may rotate releases, but should preserve stable entrypoints and recovery surfaces
- local and elevated installer file helpers should stay deterministic enough to unit-test directly
- installer service helpers should keep their privilege and platform branching injectable enough to verify routing without mutating the host service manager
- installer orchestration should delegate service-file refresh and service-manager actions through one service boundary instead of scattering duplicate restart logic across the top-level installer flow
- child apply-plan helpers should stay injectable enough to verify spawn env, spinner outcomes, fallback entry resolution, and temp-dir cleanup without launching a real installer child
- installed-runtime finalization should stay injectable enough to verify runtime publish/doc sync/manifest persistence/service startup behavior without depending on the host machine's real users or service manager
- installer prompt, confirmation, and updater copy should describe launcher-owner vs daemon-owner responsibilities honestly, especially for cross-user installs that still need elevated writes or service control
- update-target discovery should keep launcher metadata, install manifests, and managed service files consistent as parallel operator-facing recovery surfaces, while preferring target-owned sources over launcher metadata when they describe the same install
- installer path knowledge such as launcher metadata locations and manifest paths should stay centralized instead of being re-derived in multiple installer/runtime modules
- installer metadata semantics such as launcher/manifest read order, whitespace handling, and default target resolution should also live in one helper layer instead of being re-implemented by persist, updater discovery, and CLI/runtime loaders separately

## Update and deployment

For installed Rin runtimes, the standard deployment path is:

1. land the repo change
2. push it
3. run `rin update`

Avoid replacing the runtime by hand unless you are explicitly doing emergency debugging.

## Docs split

Use the right audience layer:

- user-facing: `README.md`, `docs/user/*`, `CHANGELOG.md`, `docs/troubleshooting.md`, `docs/roadmap.md`
- contributor-facing: `docs/development.md`, `CONTRIBUTING.md`, `docs/architecture.md`, `docs/security.md`, `docs/dependency-upgrades.md`, `docs/release-management.md`
- agent-facing runtime docs: `docs/rin/*`

Do not send normal users straight into agent-facing docs unless they are explicitly debugging runtime internals.
