# Comment keyset pages

The additive CommentPagePort and LocalCommentStore.listCommentPage accept a required limit (1–100), an optional after position {createdAt, commentId}, and explicit includeHidden. Results use ascending stored timestamp/ID order, with at most limit items and nextCursor only when another matching row was found. SQL fetches at most limit + 1 rows; no full target list or offset is materialized.

The default visible query filters hidden records before the limit. Migration 014 adds a partial visible-target index; moderation uses the existing target-order index. Both paths bind cell, tenant and target. Returned payload identity and ordering fields must match stored columns. Callers own actor/target authorization and owner-only admission of hidden records; this persistence port is not a public access grant.

Cursors are positions, not snapshots or signed capabilities. A deleted cursor row does not invalidate traversal. Concurrent insertions, deletions and visibility changes can affect later pages; callers requiring a stable export/reconciliation snapshot need a separate mechanism. Existing complete-list APIs remain unchanged, so downstream adoption is required to bound their HTTP responses. Tests cover tied timestamps, filtering, target/tenant isolation, limits, query-plan index use, visibility updates and restart using synthetic data.
