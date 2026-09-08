# SoundCloud normalization

Pure track, timed-comment and activity normalizers preserve the existing connector mapping, provider IDs, quoted tags, numeric/date coercion and activity fallback IDs. Tracks are external metadata references: no canonical audio `content` source is synthesized. Raw payload fields remain available for caller provenance handling and are not a public response projection.

This is behavioral extraction, not new provider admission or a strict schema validator. Existing permissive numeric coercion, type-only fallback activity IDs and date-range behavior are retained; callers must validate hostile payloads and resolve identity collisions. Network requests, credentials, pagination, recovery, publication permissions and storage remain adapter/product responsibilities. Tests use synthetic fixtures, not live provider calls.
