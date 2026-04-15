# Rin Refactor Execution Checklist

- [x] Remove jiti and unify runtime boundaries around a dist-only runtime
- [x] Include `extensions` in build outputs and eliminate source/dist mixed execution
- [x] Extract shared platform primitives and clean up duplicated infrastructure
- [x] Extract shared sidecar primitives and unify Chat / web-search lifecycle management
- [x] Add schema/type boundaries for key interfaces such as RPC, cron, and sidecar state
- [x] Add baseline test coverage for major modules and wire everything into unified `npm test`
- [x] Split `src/core/rin/main.ts`
- [x] Split `src/core/rin-install/main.ts`
- [x] Split `extensions/memory/store.ts`
- [x] Split `src/core/chat/main.ts`
- [x] Split `src/core/rin-tui/runtime.ts`
- [x] Land a unified session façade
- [x] Split memory core and derivation layers
- [x] Converge Chat into a chat bridge structure
- [x] Run builds/self-checks and remove leftover dependencies
