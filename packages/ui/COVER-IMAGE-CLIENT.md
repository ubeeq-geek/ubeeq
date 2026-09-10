# Cover image client

CreatorClient provides cover summaries, raw Blob saves, retained-original
re-cropping, removal and private JPEG previews. Focal points and named crop
overrides are serialized before awaiting transport. Preview names, output sizes,
control validation and admission remain application/API policy.

Writes carry expectedRevision. No automatic retries, source keys or persisted
credentials are introduced. Applications reconcile ambiguous replies with a
fresh summary before another write. Omitted altText on re-crop preserves the
stored description. Tests exercise compiled Node and browser targets.
