# Security and Dependency Notes

This project now passes build, lint, format, and the current automated test suite on the audited branch.

## Current dependency status

A first cleanup pass already removed the previous high-severity `basic-ftp` advisory from the lockfile path.

Remaining `npm audit --omit=dev` findings are currently concentrated in the Koishi / Satori dependency chain.

## Why they are still open

The remaining advisories are not in a state where a clean, low-risk patch update inside Rin is enough.

Current blockers:

- several findings are reported through transitive Koishi packages
- some `npm audit` fix suggestions point to semver-major or even apparently older package lines
- the Koishi runtime path is a user-facing bridge surface, so forced dependency churn without compatibility verification would be a product risk

## Policy for further cleanup

For this repo, dependency security work should follow this order:

1. prefer safe patch/minor updates
2. keep the default chat bridge path working
3. verify with full build, lint, format, and tests
4. only then consider larger Koishi stack upgrades

## Practical reading of the current state

Right now the repo is in a better state than before:

- no failing tests on the audited branch
- no lint or formatting debt on the audited branch
- no remaining high-severity production advisory in the current lockfile
- moderate advisories remain and require a more explicit Koishi compatibility pass
