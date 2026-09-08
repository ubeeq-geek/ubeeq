# Scoped creator-follow lookup

The additive `CreatorFollowLookupPort` supports a point read by user and creator.
The local adapter uses the existing cell/tenant/user/creator primary key; no
schema migration or full-list materialization is needed. It validates input IDs
and stored pair identity, returns null for absence, and returns a detached record.

The lookup grants no access: caller authentication, eligibility and transaction
boundaries remain required. The existing list interface is unchanged. Tests
cover actor, creator, tenant and cell isolation, restart, detached results and
corrupt stored identity. Pagination of full follow lists is separate work.
