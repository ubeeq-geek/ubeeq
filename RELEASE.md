# Public package release preparation

No npm package release has been published yet. Downstream source consumers must use an exact reviewed Ubeeq commit and qualified artifact hashes. Package versions express compatibility; they do not establish that a release exists.

The initial public package set is a coordinated `0.1.0` release under MIT. After a clean install, full tests and review, run `npm run release:prepare`. This builds and checks the complete public workspace inventory, packs every public package, requires a license in each archive and writes `.release-artifacts/release-candidate.json` with the exact commit, Git tree, archive integrity and SHA-256 digests. It does not publish packages, create a tag or modify deployments. Review the candidate manifest and archives before publication.

The protected `npm-publish` workflow remains an explicit owner-triggered publication step. Verify npm scope ownership and publish-environment credentials, approve the exact commit and distribution tag, then dispatch it. A successful first publication should be followed by a matching Git tag and release record with the reviewed candidate manifest. Do not describe an unpublished candidate as released.

For subsequent changes, review public exported types, entry points, schemas and persisted formats for compatibility. Update package versions and dependency ranges together when those contracts change; use prerelease versions for unqualified changes. Downstream CI must check full semver ranges plus exact source pins until consumers migrate to immutable published packages.
