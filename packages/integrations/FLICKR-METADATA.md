# Flickr metadata mapping

The shared manifest and provider-photo normalizers preserve field order, tag
trimming/deduplication, album ordering, source descriptors, licence snapshots and
provider visibility precedence. The SHA-256 hash deliberately covers the original
input JSON before normalization, matching existing saved manifests. Changing to
a canonical hash requires an explicit compatibility migration.

Provider source URLs remain capabilities, not public response fields or approved
download destinations. Callers own URL admission, rights/ownership, storage,
credential handling, public projection and publication/discovery policy. Text is
not sanitized HTML. Inputs should come from the validated inventory client;
malformed dates still reject mapping instead of silently changing provenance.
Original availability describes the provider response, not proof that bytes are
retrievable or that the caller may retain them.
