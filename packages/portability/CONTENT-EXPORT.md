# Creator-content compatibility exports

`assembleCreatorContentExport` preserves the creator-content v1 envelope used by
existing product editors. It is distinct from the revisioned repository v2
manifest and must not be treated as interchangeable with that import schema.

The caller authorizes the creator and applies per-resource export policy before
assembly. The assembler keeps complete supplied records, removes collection
memberships for omitted Works, requires unique non-empty Work IDs and clones the
result so callers cannot mutate source data through the manifest.

Products must supply an account sanitizer that excludes credentials and secrets.
The sanitizer receives a clone of each account. The generic assembler cannot
identify secrets hidden in arbitrary product metadata, and it does not claim
that unsanitized inputs are safe. It neither fetches nor packages original bytes,
provides a consistent database snapshot, or creates an authorization boundary.
