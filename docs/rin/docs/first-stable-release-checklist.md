# First stable release checklist

Use this checklist before publishing Rin stable to npm for the first time.

## One-time package readiness

- confirm the intended npm package name is `@rinchanai/rin`
- confirm the npm organization and package ownership are set correctly
- confirm the package should be public
- confirm `NPM_TOKEN` exists in GitHub repository secrets and can publish `@rinchanai/rin`
- confirm the npm account used by `NPM_TOKEN` has 2FA settings compatible with automation
- confirm `package.json` metadata is acceptable for the first public release
- confirm no files that should stay private are included in the published package

## Repository readiness

- confirm `main` remains the git-channel source of truth
- confirm the target release branch exists as `release/<major>.<minor>`
- confirm the release branch is clean and rebased onto the intended source state
- confirm `stable-bootstrap` either already exists or may be created by the workflow
- confirm GitHub Actions is enabled for the repository
- confirm the repository token permissions allow pushing workflow-generated commits and tags

## Release metadata readiness

- confirm `release-manifest.json` has:
  - `packageName: "@rinchanai/rin"`
  - correct `repoUrl`
  - correct `bootstrapBranch`
- confirm stable still uses placeholder bootstrap metadata until the first successful npm publish completes
- confirm beta metadata still points to the intended GitHub release branch flow
- confirm git metadata still points to the intended GitHub repository and default branch

## Validation readiness

Run the focused release validation set from the release branch:

```bash
npm ci --no-fund --no-audit
npm run build
node --test \
  tests/installer-modules.test.mjs \
  tests/rin-cli.test.mjs \
  tests/rpc-and-shared.test.mjs \
  tests/bootstrap-entrypoint.test.mjs \
  tests/release.test.mjs \
  tests/release-scripts.test.mjs
```

Expected status:

- this focused set passes fully
- full `npm test` may still show the current unrelated known baseline failures outside the release path

## Changelog and docs readiness

- confirm `docs/rin/CHANGELOG.md` contains the release notes you want shipped in bootstrap docs
- confirm `docs/rin/docs/release-trains.md` still matches the actual channel contract
- confirm `docs/rin/docs/releasing.md` still matches the actual workflow behavior
- confirm root `README.md` examples for install and update flags remain accurate

## First stable publish run

In GitHub Actions, run `publish-stable` with:

- `release_branch`: `release/<major>.<minor>`
- `version`: `<major>.<minor>.<patch>`

The workflow should:

1. validate the release branch with the focused release test set
2. set the requested stable version in `package.json`
3. publish `@rinchanai/rin` to npm with dist-tag `latest`
4. rewrite stable manifest metadata to the npm tarball
5. commit the updated metadata back to the release branch
6. create and push tag `v<version>`
7. regenerate and push `stable-bootstrap`

## Post-publish verification

Also verify the user-facing channel shortcuts still behave as intended:

- `rin update` resolves stable
- `rin update --beta` resolves the manifest default release branch
- `rin update --beta 0.69` resolves `release/0.69`
- `rin update --git` resolves `main`
- `rin update --git main` resolves `main`


Verify all of the following after the workflow succeeds:

- npm package page for `@rinchanai/rin` shows the new version
- `npm view @rinchanai/rin version` returns the published stable version
- `npm view @rinchanai/rin dist-tags.latest` matches the stable version
- `release-manifest.json` on the release branch now points stable to the npm tarball URL
- `stable-bootstrap` contains only the intended bootstrap payload
- tag `v<version>` exists on the remote
- a fresh stable install path resolves correctly through `./install.sh`
- an installed runtime `rin update` still resolves stable correctly

## Rollback and failure notes

- if npm publish fails, do not manually rewrite stable manifest metadata to a fake npm URL
- if npm publish succeeds but a later step fails, treat the published package as real state and repair Git metadata to match it
- if bootstrap export fails, fix the export path and rerun; do not hand-edit `stable-bootstrap`
- if the workflow-created version commit is wrong, correct it on the release branch and rerun deliberately instead of force-editing the published package history
