# Release process

Electron Dock uses immutable SemVer prereleases while its public API and
Windows interaction contract are still being validated.

## Release gates

1. Work on a branch and open a pull request against `main`.
2. Update `package.json`, `package-lock.json`, `README.md`, and
   `CHANGELOG.md` to the same version.
3. Run `npm run release:check` on Windows x64.
4. Verify the packed artifact in a fresh consumer through the repository's
   tgz consumer checks.
5. Record any manual gates that remain unaccepted. Never describe an Alpha as
   stable merely because automation is green.
6. Merge only after the Windows package CI succeeds.
7. Create an annotated immutable tag matching the package version, for
   example `v0.2.0-alpha.4`, and push it.
8. The release workflow rebuilds and verifies the tag, creates the tgz and
   SHA-256 checksum, and publishes a GitHub prerelease.

## npm publication

The tag-triggered workflow currently creates a verified GitHub prerelease only;
it does not publish to npm.

The first npm publication additionally requires ownership of the
`@tools-qweer` scope and npm Trusted Publishing (recommended) or an authorized
publisher session.

After Trusted Publishing is configured, add a protected GitHub Actions job
with `id-token: write` and publish prereleases only under the `alpha` dist-tag:

```shell
npm publish --access public --tag alpha --provenance
```

An explicitly authorized local publisher session may omit `--provenance`, but
must still use `--access public --tag alpha`. Never claim an npm publication
until the registry response and a clean consumer install have both succeeded.

Verify the result in a clean temporary project and confirm that `latest` was
not moved. Existing tags and package versions must never be replaced.

If npm credentials or scope ownership are unavailable, publish the verified
GitHub prerelease and document npm as unavailable; do not weaken authentication
or publish under an unrelated package name.
