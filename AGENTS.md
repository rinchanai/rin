# Rin repository guidelines

## Testing layout

- Keep repository tests in TypeScript under `tests/`.
- Place each new test in exactly one bucket based on the behavior it validates:
  - `tests/unit`: fast isolated logic and module coverage.
  - `tests/e2e`: multi-process or runtime-bound flows such as CLI, daemon, and persistence behavior.
  - `tests/interactive`: opt-in interactive smoke coverage that requires an explicit local test gate.
- Do not add new ad-hoc top-level test directories or mix these layers in one file.

## Test isolation

- Tests must be safe to run on a developer machine without mutating the caller's real Rin state.
- Use temporary directories and explicit runtime or agent-dir overrides for filesystem state, sockets, and process-owned data.
- E2E tests that start long-lived runtime pieces must manage lifecycle explicitly and shut them down cleanly.
- Interactive smoke tests must stay disabled by default and document the environment variable or flag needed to opt in.

## Test execution

- Use the repo scripts as the canonical entrypoints:
  - `npm run test:unit`
  - `npm run test:e2e`
  - `npm run test:interactive`
- Keep default `npm test` suitable for non-interactive automated runs.
