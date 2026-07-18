# Releasing `pygmyhippo-hermes`

The release workflow is intentionally GitHub-Release-gated: it builds the
package and runner image, tests a clean registry installation and the runner's
subprocess/callback/trace contracts, then publishes only if those jobs pass.

## One-time setup

1. In npm, configure a **trusted publisher** for package
   `pygmyhippo-hermes` using GitHub Actions repository
   `blairjordan/pygmyhippo` and workflow `.github/workflows/hermes-release.yml`.
   No long-lived `NPM_TOKEN` is used.
2. Ensure GitHub Packages is enabled for the repository. After the first
   workflow run, set `ghcr.io/blairjordan/pygmyhippo-hermes-runner` to public
   in its package settings if GitHub did not inherit the public repository
   visibility automatically.

## Release

1. Update `packages/hermes/package.json` to the intended semver version and
   add matching release notes under `docs/releases/`.
2. Commit, tag it as `v<version>`, and create a GitHub Release from that tag.
3. The `Hermes release` workflow validates the tag/version match, then creates:
   - npm package `pygmyhippo-hermes@<version>`;
   - container image `ghcr.io/blairjordan/pygmyhippo-hermes-runner:v<version>`;
   - `latest` image tag after the versioned image succeeds.
4. Confirm the workflow and install the npm package in a clean project before
   announcing the release.

The workflow deliberately tests the currently published package before publish,
then tests the exact new version after publish. This preserves the gate while
also proving the release is actually consumable from the registry.
