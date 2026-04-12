# Changelog

This file tracks notable repository changes that affect users, operators, or contributors.

The format is intentionally simple. Keep it short, readable, and focused on meaningful runtime, install, quality, and documentation changes.

## Unreleased

### Added

- richer transcript archiving, derived task anchors, and persisted session task-state snapshots for stronger task recall
- contributor-facing project docs for architecture, troubleshooting, security, roadmap, and release management

### Changed

- stabilized TUI local settings hydration and RPC/runtime host boundaries
- improved Koishi delivery and recovery handling so turn completion no longer depends on a brittle final-text race
- aligned public README entrypoints so user docs, contributor docs, and agent/runtime docs are clearly separated
- expanded install, update, troubleshooting, and getting-started docs so runtime refresh behavior and common in-session commands are easier to follow
- tightened extension build discipline so TypeScript emit does not proceed through extension build errors

### Fixed

- duplicate transcript archive ids no longer break `search_memory`
- Koishi media-only inbound messages are routed without synthetic placeholder text
- Koishi no longer posts repeated idle `Working` progress messages into chat
- `rin update` now downloads from the active `rinchanai/rin` repository instead of the retired upstream path
- installer/runtime helper regressions are now covered by tests for source archive selection, service path derivation, child apply-result parsing, builtin changelog and resume behavior, and model command edge cases
- stale cron task status is cleared on reruns

## Notes

When adding entries:

- group by user-visible impact, not by raw commit order
- mention install/update implications when relevant
- keep wording plain and audit-friendly
