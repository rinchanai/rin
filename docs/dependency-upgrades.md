# Dependency Upgrade Notes

This file tracks how Rin should approach dependency upgrades without destabilizing the main product path.

## Current stance

Use this order:

1. safe patch/minor updates
2. rebuild and run the full test/quality gates
3. review runtime-sensitive surfaces
4. only then attempt larger ecosystem upgrades

## High-risk dependency surfaces

The most sensitive dependency surface right now is the Koishi bridge stack.

Packages to treat carefully:

- `koishi`
- `@koishijs/plugin-adapter-telegram`
- `@koishijs/plugin-http`
- `@koishijs/plugin-proxy-agent`
- `koishi-plugin-adapter-onebot`
- transitive `@satorijs/*` and `@cordisjs/*`

## Validation checklist for dependency changes

For any nontrivial update, run:

```bash
npm run build:vendor
npm run build:core
npm run build:extensions
npm run lint
npm run format:check
node --test tests/*.test.mjs extensions/memory/memory.test.mjs extensions/self-improve/self-improve.test.mjs
npm audit --omit=dev --json
```

Then manually inspect whether these still look coherent:

- Koishi inbound routing
- outbound chat delivery
- media restore behavior
- daemon startup and shutdown
- TUI reconnect and session restore

## Practical rule

If an audit suggestion implies a semver-major jump, a downgrade, or a contradictory path, do not apply it mechanically.

Treat it as a compatibility task, not a package-manager chore.

## Current known case

Rin already removed the earlier high-severity `basic-ftp` advisory path through safe lockfile refresh.

Remaining moderate findings are mostly Koishi-chain items and need explicit compatibility validation rather than blind forced upgrade churn.

Current `npm audit --omit=dev` package names include:

- `@cordisjs/plugin-http`
- `@cordisjs/plugin-proxy-agent`
- `@koishijs/core`
- `@koishijs/loader`
- `@koishijs/plugin-adapter-telegram`
- `@koishijs/plugin-http`
- `@koishijs/plugin-proxy-agent`
- `@koishijs/plugin-server`
- `@satorijs/adapter-telegram`
- `@satorijs/core`
- `file-type`
- `koishi`
- `koishi-plugin-adapter-onebot`
