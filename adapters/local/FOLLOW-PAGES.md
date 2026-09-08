# Follow keyset pages

The additive follow page port and service read a bounded page by user, ordered
by creator ID. The local adapter uses its existing cell/tenant/user/creator key
with `creator_id > afterCreatorId` and at most limit+1 rows (limit 1–100). It does
not materialize the complete list or use an offset scan. No schema change is
needed. The service applies the same list authorization callback.

`nextCreatorId` is a position, not a signed capability or snapshot. Deleting the
cursor record does not prevent resumption; concurrent additions/removals can
change later results. Authorization and scope apply independently of the cursor.
Existing list APIs remain unchanged. Tests cover ordered pages, tenant/user
isolation, restart after cursor deletion, bounds and denied service admission.
