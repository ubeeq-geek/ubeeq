# Flickr source workflow errors

Transfer, quarantine-scanner and attachment ports can throw errors containing
signed URLs, credentials or private object identifiers. The shared source workflow
persists only exact recognized download error codes. Other failures become
`FLICKR_SOURCE_TRANSFER_FAILED` in both item state and new audit events.

Only `FLICKR_SOURCE_TEMPORARILY_UNAVAILABLE` schedules the existing bounded retry;
the exact legacy `TEMPORARILY_UNAVAILABLE` message maps to that code. Only the exact
`FLICKR_SOURCE_UNAVAILABLE` code marks an item unavailable. Arbitrary messages with
those words do not control retry or terminal state. Unknown failures remain failed
for review, not automatically retried. Admission failures still abort without
checkpointing and must be safely projected by the calling application.

This is forward-looking normalization, not a cleanup of historical records.
Already persisted item errors and audit events are retained. Callers must continue
to redact their browser projections and protect stored history. The original
port exception is deliberately not copied into the migration or logged here.
