# Releasing Rin

This document describes the operator workflow for Rin release trains.

## Preconditions

- publish from a clean `release/<major>.<minor>` branch
- keep `main` as the git-channel source of truth
- configure repository secret `NPM_TOKEN` for `@rinchanai/rin`
- confirm the targeted release tests pass on the release branch
- update `docs/rin/CHANGELOG.md` before the workflow if release notes changed

## Channel contract

- stable: default install and update channel, published to npm with dist-tag `latest`
- beta: explicit opt-in only, published from release branches through GitHub archives
- git: explicit opt-in only, resolved directly from GitHub refs

## First stable release preparation

Before the first real stable publish:

1. ensure the npm package `@rinchanai/rin` exists and the publish token can write to it
2. confirm `package.json` metadata is acceptable for public npm publication
3. confirm `release-manifest.json` still uses only a temporary placeholder stable archive until the first publish succeeds
4. after the first successful stable publish, let the workflow rewrite the stable manifest entry to the npm tarball

## Beta release

Use GitHub Actions `publish-beta` with:

- `release_branch`: `release/<major>.<minor>`
- `version`: `<major>.<minor>.<patch>-beta.<n>`

The workflow will:

1. check out the selected release branch
2. install dependencies and run the targeted release validation set
3. set `package.json` version to the requested beta version
4. rewrite `release-manifest.json` beta metadata for that branch and version
5. commit the updated package and manifest metadata back to the release branch
6. regenerate and push the `stable-bootstrap` branch payload

## Stable release

Use GitHub Actions `publish-stable` with:

- `release_branch`: `release/<major>.<minor>`
- `version`: `<major>.<minor>.<patch>`

The workflow will:

1. check out the selected release branch
2. install dependencies and run the targeted release validation set
3. set `package.json` version to the requested stable version
4. publish `@rinchanai/rin` to npm using dist-tag `latest`
5. rewrite `release-manifest.json` stable metadata to the npm tarball
6. commit the updated package and manifest metadata back to the release branch
7. create and push tag `v<version>`
8. regenerate and push the `stable-bootstrap` branch payload

## Stable bootstrap branch

`stable-bootstrap` is generated output, not a development branch.

It should contain only:

- `install.sh`
- `update.sh`
- `release-manifest.json`
- `docs/rin/CHANGELOG.md`
- generated bootstrap `README.md`

To regenerate locally:

```bash
npm run release:bootstrap -- --output /path/to/stable-bootstrap-worktree
```

## Local manifest maintenance

Stable:

```bash
npm run release:manifest -- --channel stable --version <x.y.z>
```

Beta:

```bash
npm run release:manifest -- --channel beta --branch release/<x.y> --version <x.y.z-beta.n>
```

## Validation set used by release workflows

The release workflows intentionally use the focused validation set that already covers the channel/bootstrap/install paths:

```bash
npm run build
node --test \
  tests/installer-modules.test.mjs \
  tests/rin-cli.test.mjs \
  tests/rpc-and-shared.test.mjs \
  tests/bootstrap-entrypoint.test.mjs \
  tests/release.test.mjs \
  tests/release-scripts.test.mjs
```

This avoids blocking releases on the current unrelated baseline failures outside the release path.
