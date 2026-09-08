# Scoped comment lookup

LocalCommentStore implements the additive CommentLookupPort. getComment(targetType, targetId, commentId) selects a single row by the existing cell/tenant/comment primary key and verifies the requested target in SQL and the stored payload. Missing or foreign-target records return null; malformed lookup identifiers or inconsistent stored identity fail explicitly.

The lookup returns raw records including hidden comments for authorized retry and moderation workflows. It is not a public read service or authorization grant. Callers must admit the actor and target, and perform checks and mutations in their transaction when atomicity is required. No new schema, list pagination, deletion tombstone or retention policy is introduced. Tests cover scope isolation, hidden records, detached results, restart and inconsistent payload rejection with synthetic local data.
