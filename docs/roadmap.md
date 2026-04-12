# Rin Roadmap

This is a practical near-term roadmap, not a marketing promise list.

## 1. Default-path stability

Keep the main user path predictable:

- TUI + daemon reconnect behavior
- session binding and restore behavior
- Koishi chat turn delivery and recovery
- install and update workflows

## 2. Recoverable task state

Move beyond plain transcript recall toward stronger task continuation.

Priority areas:

- richer progress anchors for multi-step web tasks
- better recovery of "what was already done"
- clearer distinction between durable memory and resumable work state

## 3. Koishi bridge hardening

Continue improving the bridge as a first-class surface:

- media handling
- recovery after interrupted turns
- outbound delivery robustness
- compatibility with common chat adapters

## 4. Codebase simplification

Continue splitting oversized modules and clarifying ownership boundaries.

Current focus:

- `src/core/rin-tui/`
- `src/core/rin-daemon/`
- `src/core/rin-koishi/`
- `src/core/subagent/`

## 5. Dependency hygiene

Keep production dependencies current without forcing risky churn into the default path.

Work items:

- safe patch/minor updates first
- explicit validation for Koishi-stack upgrades
- audit noise reduction where advisories are stale or misleading

## 6. Better contributor ergonomics

Improve the repo as a place to work in:

- clearer architecture docs
- troubleshooting notes
- dependency upgrade playbooks
- more direct ownership and boundary documentation
