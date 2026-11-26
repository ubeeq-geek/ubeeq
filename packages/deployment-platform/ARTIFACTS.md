# Deployment artifacts

Schema 1 remains readable for existing releases. Its directory digest is SHA-256
of sorted relative POSIX file paths followed by their bytes. Legacy consumers
may supply their historical excluded directory names when hashing schema 1.
Schema 1 revisions are compared as exact strings against the expected revision.

Schema 2 retains product, revision and artifacts, and requires appCode,
coreCommit, commercialCommit and a boolean migrationReady. Commit identifiers
are full lowercase Git SHA-1 values. Consumers bind those fields to their reviewed
deployment configuration. requireMigrationReady rejects review candidates during
release staging. Review tools can validate candidates with that option omitted.

Each artifact has a relative path, positive fileCount and lowercase SHA-256.
Component names are checked against the consumer's complete expected set.
Absolute paths, parent traversal and symbolic links are rejected.

Use hashDeploymentArtifactDirectory(directory, schemaVersion) on both sides of
the handoff. Schema 2 hashes sorted relative POSIX file paths with a NUL after
each path and after each file's bytes. All regular files participate, including
hidden files. Empty trees and special files are rejected. Artifact trees must be
immutable while they are hashed and transferred.

Schema 3 keeps schema 2 provenance and changes the digest format. SHA-256 starts
with the UTF-8 prefix `ubeeq-deployment-artifact-v3` followed by a zero byte.
For each file in the same sorted path order, hash an unsigned 64-bit big-endian
path byte length, the UTF-8 path, an unsigned 64-bit big-endian content byte
length, and the file bytes. Directory entries must decode without Unicode
replacement characters. The lengths delimit empty files and arbitrary binary
content. Consumers can pin the reviewed release format with
`expected.schemaVersion`. Upgrade verifiers and producers together before
promoting schema 3. Existing schema 2 digests retain their original format.

A consumer can upgrade its contract implementation while retaining an old app
pin. Configure the new app revision and its exact upstream pins together before
promoting schema 2. Version 1 manifests have no migrationReady field, so existing
release records continue through the version 1 validation path.
