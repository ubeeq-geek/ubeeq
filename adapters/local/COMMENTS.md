# Durable local comments

`LocalCommentStore(database, tenantId)` supplies `CommentService` persistence.
Migration 013 preserves comments by cell/tenant/comment ID and indexes target
reads. Create is insert-only; a duplicate ID raises `UniqueConstraintError` rather
than overwriting an existing body or moderation state. Operations participate in
the local database transaction when composed within it.

Raw adapter reads include hidden comments. The shared service filters hidden
records after product authorization. Neither layer sanitizes content for HTML or
grants target access; products must supply admission, moderation and safe rendering.
Lists materialize complete target history and are not paginated. Moderation edits,
deletion policy, audit composition, product routes/UI and export remain unfinished.
No existing product comment store is replaced automatically by this adapter.
