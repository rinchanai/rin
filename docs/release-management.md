# Release and Version Management

This document explains how Rin should handle release flow, change tracking, and version discipline without adding unnecessary process overhead.

## Current release stance

Rin currently ships through a repository-first workflow:

1. make the repo change
2. validate it
3. push it
4. update installed runtimes with `rin update`

That means the repository remains the source of truth, while installed runtimes are treated as deployable outputs.

## Branching and landing

For bounded cleanup or stabilization work:

- use a focused branch
- keep commits small and legible
- prefer Conventional Commits
- land only validated changes

For larger work:

- split structural refactors from behavior changes
- keep docs and tests close to the code they justify
- avoid mixing unrelated cleanup into a risky path

## Version discipline

Even when the package is private, version management still matters.

Use these rules:

- track meaningful user-facing changes in `CHANGELOG.md`
- treat install/update path changes as release-sensitive
- treat TUI, daemon, Koishi bridge, memory, and installer changes as high-impact surfaces
- make rollback easier by keeping commits scoped and descriptive

## Change log policy

`CHANGELOG.md` should stay concise and useful.

It should answer:

- what changed
- who it matters to
- whether install/update/runtime behavior changed
- whether a migration or caution note exists

Do not turn it into a noisy commit dump.

## Release checklist

Before treating a branch state as release-worthy, verify:

```bash
npm run build:vendor
npm run build:core
npm run build:extensions
npm run lint
npm run format:check
node --test tests/*.test.mjs extensions/memory/memory.test.mjs extensions/self-improve/self-improve.test.mjs
```

Also inspect whether the change affects:

- install flow
- `install.sh` bootstrap behavior
- runtime publishing under `app/releases/...`
- `app/current` symlink switching
- old release pruning
- `rin update`
- daemon boot / reconnect
- TUI default path
- Koishi bridge delivery
- transcript and memory recall
- public-facing docs

## Release artifact contract

Treat the installed runtime layout as an operator-facing contract, not an internal accident.

At minimum, a healthy installed update should keep these expectations true:

- a new runtime is published under `app/releases/<timestamp>/`
- `app/current/` becomes the stable pointer to the active runtime
- launcher scripts continue to target the stable `app/current/...` entrypoints
- installed docs continue to land in stable `docs/rin` and `docs/pi` locations
- older releases are pruned conservatively instead of accumulating forever
- direct troubleshooting commands prefer `app/current/...` over timestamped release paths
- changelog and operator docs mention user-visible install/update behavior changes

## Update notes

If a change modifies runtime behavior in a way users may notice, document it in one or more of:

- `CHANGELOG.md`
- `README.md`
- `docs/user/getting-started.md`
- `docs/troubleshooting.md`

## Practical policy

Prefer a boring release process over a clever one.

Rin should be easy to update, easy to reason about, and easy to audit after the fact.
