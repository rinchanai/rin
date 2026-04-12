# Contributing to Rin

Thanks for helping with Rin.

## Ground rules

- prefer KISS over cleverness
- fix the real boundary instead of stacking workaround layers
- keep default user paths stable before expanding feature breadth
- keep docs in sync with behavior changes
- keep repo changes in Rin-owned code; do not modify `third_party/` unless the task is explicitly upstream-sync work

## Before opening a change

Run:

```bash
npm install
npm run build
npm run lint
npm run format:check
node --test tests/*.test.mjs extensions/memory/memory.test.mjs extensions/self-improve/self-improve.test.mjs
```

## Commit style

Use Conventional Commits.

Examples:

- `fix(tui): keep local ui settings stable before session attach`
- `refactor(koishi): split delivery state helpers`
- `docs(readme): separate user docs from agent docs`

## Documentation expectations

If behavior changes, update the right docs layer:

- product/user docs: `README.md`, `docs/user/*`, `CHANGELOG.md`
- contributor docs: `docs/development.md`, `CONTRIBUTING.md`, `docs/release-management.md`
- agent/runtime docs: `docs/rin/*`

## Safe-change checklist

Before landing a bounded cleanup or stabilization change, confirm:

- the change scope is explicit and small enough to validate
- the highest-risk user path affected is clear
- docs changed together with user-visible behavior when needed
- tests were added or updated for the boundary being fixed
- the repo is clean after build, lint, format, and test checks

For installed runtimes, the normal deployment path is still:

1. land the repo change
2. push it
3. run `rin update`

## High-risk areas

Please be extra careful around:

- `src/core/rin-tui/`
- `src/core/rin-daemon/`
- `src/core/rin-koishi/`
- `src/core/rin-install/`
- `extensions/memory/`

Changes in those areas should come with tests or an explicit reason why tests cannot be added.
