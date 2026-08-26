# Releasing public packages

Public package releases are versioned and independent of hosted-product releases.

1. Run `npm run pack:verify`. This verifies the public boundary, TypeScript build, and package contents.
2. Select the semantic version for each changed package and update its `package.json`.
3. Confirm private product compatibility runs against the release candidate in their private CI.
4. Use the manual **Publish public packages** workflow from the protected `npm-publish` environment. It publishes with npm provenance and requires only the `NPM_TOKEN` environment secret, scoped to package publishing rather than repository administration.
5. Update the private product dependency pins only after their compatibility run passes.

The first release publishes `@ubeeq/extension-sdk` before `@ubeeq/api`; the API now declares the SDK through its public semver range. Package tarballs contain compiled `dist/` artifacts only.

This repository does not publish automatically. Configure npm trusted publishing or provide the protected `NPM_TOKEN` secret before manually dispatching the workflow.
