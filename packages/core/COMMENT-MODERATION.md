# Comment moderation boundary

`CommentModerationService` composes a tenant/cell-bound `CommentModerationPort` with caller-supplied authorization for the exact operation, comment ID and actor. `setHidden` accepts only an explicit boolean; `delete` forwards an authorized deletion. Missing IDs, blank actors, denied policy and malformed visibility never reach storage. Policy and storage failures propagate.

The caller must resolve target ownership, moderator roles and applicable policy; an ID alone is not permission. The port must not cross tenant boundaries. Existing-record checks, concurrency, idempotent missing-record semantics, audit atomicity and retention belong to the storage/product composition, not this orchestration boundary. This service does not add a route, grant moderation privileges, or delete any records by itself.
