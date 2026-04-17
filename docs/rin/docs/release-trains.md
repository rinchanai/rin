# Release trains

Rin uses a three-channel train model.

## Channels

- stable: default for install and update
- beta: explicit opt-in only
- git: explicit opt-in only

## Branches

- `main`: git channel source of truth
- `release/<major>.<minor>`: beta and stable release train branch
- `stable-bootstrap`: generated branch that only stores:
  - `install.sh`
  - `update.sh`
  - `release-manifest.json`
  - `docs/rin/CHANGELOG.md`

## User-facing rules

- `./install.sh` and `rin update` target stable by default
- beta requires `--beta`
- git requires `--git`
- beta supports `--branch <release/x.y>` and `--version <x.y.z-beta.n>`
- git supports `--branch <name>` and `--version <tag-or-commit>`

## CI workflows

- `ci.yml`: build and test on `main` and `release/**`
- `publish-beta.yml`: publish a beta package and refresh `stable-bootstrap`
- `publish-stable.yml`: publish a stable package, tag it, and refresh `stable-bootstrap`

Required repository secrets:

- `NPM_TOKEN`: npm publish token for `@rinchanai/rin`

## Release manifest

`release-manifest.json` is the bootstrap source of truth.

- stable entries point to the current npm stable tarball
- beta entries map a release branch to its latest beta tarball
- git remains branch/ref based and resolves directly from GitHub
