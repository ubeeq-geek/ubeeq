# SoundCloud write client

SoundCloudWriteClient composes the bounded SoundCloudTransport for explicit metadata updates, deletion, timed comments, likes, reposts and follows. Construction does nothing. Callers own authorization, capability admission, confirmation, credential handling, durable intent and reconciliation. This is not an automatic publisher or a grant of permission to mutate provider data.

The extracted mapping retains explicit empty metadata values, no-op empty updates, integer/nonnegative timestamp normalization, encoded identifiers and DELETE-only missing-resource tolerance. Timed comments require a normalized provider receipt identity; missing identity or uncertain transport outcomes are ambiguous_submission. No automatic retry occurs. A remote write may have succeeded before its receipt failed; caller reconciliation is required before replaying non-idempotent effects.

These are compatibility request helpers, not strict input schemas. Runtime validation of text, tag budgets, timestamp finiteness and product policy remains caller-owned/follow-up work. Successful metadata responses retain the existing transport object requirement, while state operations accept empty successful responses. Uploads, account-health policy, persistence, retry scheduling and full connector packaging are separate. Tests use injected synthetic responses only, not real provider writes.
