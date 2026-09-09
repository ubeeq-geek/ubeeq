# Request-scoped square crops

SharpImageRenditionProcessor accepts an optional squareCrop on each process input,
overriding its constructor default for that request only. Coordinates refer to
source pixels before EXIF orientation, with the existing shared floor/clamp rules.
The crop is snapshotted before asynchronous decoding. Four fitted recipes remain
unchanged; the three square recipes use the selected crop and report its applied
coordinates in output metadata. Resource budgets and source lineage are unchanged.

This does not yet expose crop editing in a product. Applications must admit and
persist crop requests with source/version and retry identity, select this capable
processor, and commit replacements under the existing job lease. Other processor
implementations are not implicitly crop-capable. Durable job plumbing and product
crop controls remain unfinished; no existing media is automatically regenerated.
