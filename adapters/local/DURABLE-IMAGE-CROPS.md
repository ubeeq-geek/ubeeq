# Durable image crop requests

CreatorAssetRegenerationService snapshots and validates optional squareCrop before
authorization, and passes a separate copy to the admission callback. The local
store requires both image processing and explicit allowSquareCrop configuration.
It records the crop in the existing atomic regeneration job transaction, preserving
current outputs. Same-key retries must carry the same canonical crop (including
absence); a changed crop is invalid_request, not a new job. Distinct crop attempts
need new request keys and still cannot overlap active processing.

CreatorAssetWorker also requires allowSquareCrop. It snapshots the leased payload,
validates crop and image type before source I/O, and passes the crop to the
configured crop-capable processor. Existing source integrity, byte budgets,
attempt-specific output storage and lease-fenced commit remain in force. Restart,
dead-letter and recovery retain the selected crop. Requests without a crop retain
the previous default behavior; this does not automatically preserve an earlier
request's custom crop when a later request omits it.

Product routes, configuration and crop controls are not enabled by this change.
Applications must install a capable image processor before opting in. No existing
media is regenerated and no live records are changed by package adoption alone.
