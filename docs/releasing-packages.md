# Releasing public packages

Public package releases are versioned and independent of hosted-product releases.

1. Run `npm run pack:verify`. This verifies the public boundary, TypeScript build, and package contents.
2. Select the semantic version for each changed package and update its `package.json`.
3. Confirm private product compatibility runs against the release candidate in their private CI.
4. Publish only from protected CI using provenance and an automation token that has package-publish access but no repository-administration access.
5. Update the private product dependency pins only after their compatibility run passes.

Do not publish a package until its dependency declaration can be installed from the chosen public registry. The current workspace links are intentionally local-development links until that first registry release is configured.

