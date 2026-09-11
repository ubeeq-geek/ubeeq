# SoundCloud normalization

Pure track, timed-comment and activity normalizers preserve the existing connector mapping, provider IDs, quoted tags, numeric/date coercion and activity fallback IDs. Tracks are external metadata references: no canonical audio `content` source is synthesized. Raw payload fields remain available for caller provenance handling and are not a public response projection.

Activity without a provider event ID now requires an explicit type, actor, track and valid occurrence date before using the existing fallback ID format. Incomplete identity throws ExternalProviderError with invalid_response rather than collapsing unrelated events into a type-only ID or silently filtering them out. Callers must fail the page without advancing its checkpoint. Provider IDs and complete historical fallback IDs retain their format; no stored records are rewritten.

This is not new provider admission or a strict schema validator. Permissive numeric coercion and date-range behavior remain; callers must validate hostile payloads. Complete fallback tuples are still not a provider uniqueness guarantee (two events can share a tuple); provider-issued IDs remain preferable. Network requests, credentials, pagination, recovery, publication permissions and storage remain adapter/product responsibilities. Tests use synthetic fixtures, not live provider calls.
