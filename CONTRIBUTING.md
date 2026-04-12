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

- product/user docs: `README.md`, `docs/user/*`
- contributor docs: `docs/development.md`, `CONTRIBUTING.md`
- agent/runtime docs: `docs/rin/*`

## High-risk areas

Please be extra careful around:

- `src/core/rin-tui/`
- `src/core/rin-daemon/`
- `src/core/rin-koishi/`
- `src/core/rin-install/`
- `extensions/memory/`

Changes in those areas should come with tests or an explicit reason why tests cannot be added.
