# Shared metadata commands

`collectionMetadataCommands.createMetadataCommandProcessor` owns the retained
metadata-only command orchestration for initialize, relate, refresh, configuration
preview, propose, copy preview, apply, reject, pause, resume and detach. It uses the
existing domain and relationship service, preserving exact-value review, field
ownership, rejection hashes, proposal supersession, attention and audit behavior.

The factory requires explicit host authorization, feature enablement, actor
recording, authorized endpoint discovery, installation graph reads, ID and clock
ports. Authorization receives the complete collection and must verify its current
tenant/Creator binding and the authenticated actor. There are no authorization,
endpoint or feature defaults. Every service/domain dependency is also required.

Execution mutates an explicitly private working state and returns any updated
collection, candidate graph, expected graph revision and result ID. It never
persists, advances the metadata revision, records an idempotency receipt, claims
a lease or writes a remote provider. The host must retain authenticated routing,
request replay/version checks and its actual writer lease, then atomically commit
the collection, metadata, organization, graph and current authority for all
recorded actors. Current account activity and leases belong in those commit-time
guards as well as preflight. The returned result grants no publication authority.

Legacy discovery remains Related only and observes no remote content. Relating
selects an existing authorized endpoint. Copy and proposal selections cannot
bypass SOURCE ownership. Pending incoming values never become public through an
ordinary catalogue edit. Exact review and application remain in the relationship
service; native opaque fields are retained by its generic collection update.

A refresh that cannot read its endpoint intentionally returns a paused working
connection, blocked pending proposals and attention/audit information. If any
other command throws, discard its working copy; observation or legacy-discovery
work may already have changed that copy. Any failed-attempt diagnostic must use
a fresh state and retain the host's current authority and acquired lease.

Pause and resume return a graph revision candidate without acquiring or changing
the host graph. Pause retains the route reservation; detach releases it in the
candidate graph while preserving connection and observation history. Applying a
candidate still requires the enclosing atomic graph condition.

HTTP views, signed import previews/import creation, publishing comparisons,
worker scheduling, managed adoption and browser bindings remain host integration
work. This extraction does not enable a managed route or move a data owner.
The unit suite exercises required ports, denied/disabled calls, initialization,
authorized relationships, exact source application, field ownership, offline
refresh, graph lifecycle and rejected-value review. Native route integration and
product acceptance remain required before adopting the processor in a host.
