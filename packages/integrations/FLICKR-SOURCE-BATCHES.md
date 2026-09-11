# Flickr source batch complexity

The source workflow inspects at most 10 items by default (configurable 1–100).
It scans the photo catalogue once to collect first matches for the requested
batch IDs, retaining at most the batch size in its lookup map. Audit events compare
only the processed slice with its original positions. This removes repeated
catalogue searches and the former quadratic whole-item audit search.

Provider work, item order, retry timing, retained quarantine handling and saved
continuation remain unchanged. Missing sources remain unavailable; duplicate
photo IDs retain the first photo, matching the prior lookup behavior. Only actual
status changes within the current batch generate transfer audit events.

This is not bounded-memory persistence: copying items, checking whole-migration
completion, accumulating audit history and serializing the saved JSON record
remain proportional to catalogue/history size. Indexed item storage and bounded
checkpoints remain necessary before claiming large-catalogue serverless readiness.
