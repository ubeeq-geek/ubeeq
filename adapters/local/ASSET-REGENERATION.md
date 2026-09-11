# Asset regeneration

`CreatorAssetRegenerationService` authorizes the current Work and invokes a
required caller-owned admission callback before every request, including replay.
Bind authorization to the authenticated actor; do not expose the adapter directly.
The request carries the expected Work revision, current source version and a
bounded retry key. Changing the key deliberately creates a new attempt.

The local store atomically rechecks ownership, membership, revision and source,
requires an enabled media processor, and rejects overlapping active asset jobs.
The retry key is scoped to tenant, creator, Work, asset and source. Replaying a
terminal request returns that job; it does not silently restart it. A new key is
needed after failure. Replay remains subject to current revision and admission.

Enqueue and the latest-job fence commit together. Existing completed renditions
are retained during queued/running/failed regeneration. The existing worker swaps
the complete result and completes its lease atomically. An older failed job that
is later recovered cannot commit over a newer admitted request. Its attempted
outputs may become unreferenced and require eventual garbage collection.

No Work revision, publication receipt or original object is rewritten by enqueue.
Changing completed derivative references invalidates their previous delivery
versions. Objects are retained, not physically erased. This is a shared local
mechanism, not an HTTP endpoint, a crop editor, an automatic bulk backfill or a
cloud implementation. Product API/UI composition and policy remain required.
