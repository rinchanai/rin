# First stable release checklist

Use this checklist before the first real stable npm promotion.

## One-time package readiness

- confirm the intended npm package name is `@rinchanai/rin`
- confirm the npm organization and package ownership are set correctly
- confirm the package should be public
- confirm `NPM_TOKEN` exists in GitHub repository secrets and can publish `@rinchanai/rin`
- confirm the npm account used by `NPM_TOKEN` has 2FA settings compatible with automation
- confirm `package.json` metadata is acceptable for the first public release
- confirm no files that should stay private are included in the published package

## Repository readiness

- confirm `main` remains the development source of truth
- confirm `stable-bootstrap` either already exists or may be created by the workflows
- confirm GitHub Actions is enabled for the repository
- confirm the repository token permissions allow pushing workflow-generated commits and tags
- confirm `release-manifest.json -> train.series` is set to the intended initial stable `major.minor` line

## Release metadata readiness

- confirm `release-manifest.json` has:
  - `packageName: "@rinchanai/rin"`
  - correct `repoUrl`
  - correct `bootstrapBranch`
  - correct `train.series`
  - correct `train.nightlyBranch`
- confirm stable still uses placeholder bootstrap metadata until the first successful npm publish completes
- confirm beta metadata points to the intended weekly beta candidate shape
- confirm nightly metadata points to the intended nightly shape
- confirm git metadata still points to the intended GitHub repository and default branch

## Validation readiness

Run the focused release validation set from `main`:

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
- confirm `docs/rin/docs/release-trains.md` still matches the actual channel contract and cadence
- confirm `docs/rin/docs/releasing.md` still matches the actual workflow behavior
- confirm root `README.md` examples for install and update flags remain accurate

## First stable publish run

Before the first real stable promotion:

1. let `publish-beta` cut a beta candidate on schedule or by manual dispatch
2. verify that `release-manifest.json -> beta` now contains the intended candidate ref and version
3. run or wait for `publish-stable`
4. confirm the stable workflow promotes that beta candidate ref instead of rebuilding from newer `main`

The stable workflow should:

1. validate the pinned beta candidate with the focused release test set
2. set the promotion version only inside the detached candidate worktree
3. publish `@rinchanai/rin` to npm with dist-tag `latest`
4. rewrite stable manifest metadata to the npm tarball and promoted ref
5. tag the promoted candidate ref as `v<version>`
6. commit the manifest update back to `main`
7. regenerate and push `stable-bootstrap`

## Post-publish verification

Also verify the user-facing channel shortcuts still behave as intended:

- `rin update` resolves stable
- `rin update --beta` resolves the current weekly beta candidate
- `rin update --nightly` resolves the current nightly build
- `rin update --git` resolves `main`
- `rin update --git main` resolves `main`

Verify all of the following after the workflow succeeds:

- npm package page for `@rinchanai/rin` shows the new version
- `npm view @rinchanai/rin version` returns the published stable version
- `npm view @rinchanai/rin dist-tags.latest` matches the stable version
- `release-manifest.json` on `main` now points stable to the npm tarball URL and promoted ref
- `stable-bootstrap` contains only the intended bootstrap payload
- tag `v<version>` exists on the remote and points to the promoted beta candidate ref
- a fresh stable install path resolves correctly through `./install.sh`
- an installed runtime `rin update` still resolves stable correctly

## Rollback and failure notes

- if npm publish fails, do not manually rewrite stable manifest metadata to a fake npm URL
- if npm publish succeeds but a later step fails, treat the published package as real state and repair Git metadata to match it
- if bootstrap export fails, fix the export path and rerun; do not hand-edit `stable-bootstrap`
- if the workflow-created beta candidate is bad, do not promote it; cut a new beta candidate first
- if a hotfix is required between beta cut and stable promotion, use `publish-hotfix.yml` and let the next stable promotion pick the next available patch version
