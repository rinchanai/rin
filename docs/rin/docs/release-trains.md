# Release trains

Rin uses a three-channel train model.

## Channels

- stable: default for install and update, resolved from npm release metadata
- beta: explicit opt-in only, resolved from GitHub release-train branches
- git: explicit opt-in only, resolved directly from GitHub refs

## Branches

- `main`: git channel source of truth
- `release/<major>.<minor>`: beta and stable release-train branch
- `stable-bootstrap`: generated branch that only stores:
  - `install.sh`
  - `update.sh`
  - `release-manifest.json`
  - `docs/rin/CHANGELOG.md`

## User-facing rules

- `./install.sh` and `rin update` target stable by default
- `--beta` must be requested explicitly
- `--beta` with no suffix means the latest release train from the manifest default branch
- `--beta 0.69` means `release/0.69`
- `--git` must be requested explicitly
- `--git` with no suffix means `main`
- `--git <name>` means that branch or ref directly
- `--branch` / `--version` remain supported as explicit selectors

## Release manifest

`release-manifest.json` is the bootstrap source of truth.

- stable entries point to the current npm stable tarball
- beta entries map a release branch to its GitHub archive
- git remains branch/ref based and resolves directly from GitHub

## Automation

- `npm run release:manifest -- --channel stable --version <x.y.z>` updates stable npm metadata
- `npm run release:manifest -- --channel beta --branch <release/x.y> --version <x.y.z-beta.n>` updates beta GitHub metadata
- `npm run release:bootstrap -- --output <dir>` exports the stable bootstrap branch payload
