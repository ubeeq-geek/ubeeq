# Vimeo byte transfer

`transferVimeoUpload` resumes a known ticket from the provider's authoritative
offset, reads one bounded chunk at a time, validates advancement, then awaits a
caller checkpoint before reading the next chunk. It rejects offsets beyond the
declared source size and short reads. A checkpoint or transport failure stops the
loop immediately; resumption must query the provider again.

Chunks default to 8 MiB and may be configured up to 64 MiB. This bounds individual
source reads, not whole-job runtime: the helper transfers the remaining source.
An optional positive `maxChunks` budget yields the last checkpointed offset;
callers compare it with source size and schedule continuation when incomplete.
Omitting this budget retains whole-source transfer behavior. The caller still
needs wall-clock budgeting and durable job scheduling for large
sources, upload URL admission, creator/source authorization, ticket persistence,
worker coordination and uncertain-creation reconciliation. No remote creation,
metadata changes, or implicit retries occur in the helper.

Tests cover resumed byte ranges, progress ordering, impossible offsets, short
reads, non-advancing responses and checkpoint failures using fake protocol ports.
