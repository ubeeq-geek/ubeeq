# Original and active objects sharing source keys

Regional exports retain an explicit original inventory entry whenever an asset
has originalStorage, even when its key equals the active storage key. A key
alone does not identify a stored object: source buckets and versions matter too.

If the two entries would target the same destination key, the original receives
a separate creator-scoped originals key derived deterministically from the
migration and asset IDs. Both source references retain their bucket and version.
This avoids overwriting one version with another at the currently unversioned
destination locations and satisfies import's explicit-original requirement.
The same physical source object is intentionally copied twice when both roles
refer to it; storage deduplication is not assumed.

Real local storage tests cover separate keys, different versions sharing one
key, and two references to the same object. Each runs transfer byte verification,
atomic import retries, conflict checks, and rollback or retirement. Original
bytes and active bytes remain independently readable after import. No live
storage, retained metadata, or publication policy is changed. Provider-specific
version receipts and concurrent transfer fencing remain future work.
