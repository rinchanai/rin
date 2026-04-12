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

## Update and deployment

For installed Rin runtimes, the standard deployment path is:

1. land the repo change
2. push it
3. run `rin update`

Avoid replacing the runtime by hand unless you are explicitly doing emergency debugging.

## Docs split

Use the right audience layer:

- `README.md`, `docs/user/*`: user-facing
- `docs/development.md`, `CONTRIBUTING.md`: contributor-facing
- `docs/rin/*`: agent-facing runtime docs

Do not send normal users straight into agent-facing docs unless they are explicitly debugging runtime internals.

## Security notes

Dependency security status and remaining audit constraints are tracked in:

- `docs/security.md`
- `docs/dependency-upgrades.md`

Release tracking and version-management guidance live in:

- `CHANGELOG.md`
- `docs/release-management.md`

## Project planning and troubleshooting

Additional working docs:

- `docs/roadmap.md`
- `docs/troubleshooting.md`
- `docs/release-management.md`
