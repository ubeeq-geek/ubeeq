# Explicit image crop requests

`CreatorClient.regenerateAsset(workId, assetId, expectedRevision,
sourceVersionId, idempotencyKey, squareCrop?)` accepts an optional
`{ x, y, size }` in original source pixels, before EXIF orientation.

The request is serialized immediately. Caller mutation cannot alter an in-flight
request. The client does not retry automatically or remember a crop. After an
ambiguous response, the application must retain and resend the same coordinates,
source, revision and key. Changing or omitting the crop with an existing key is
rejected by the durable server contract.

Omitting the final argument preserves the existing request body. A new request
without a crop uses the processor default, not the previous crop. Authorization,
validation, image-only capability, bounds and durable job admission remain the
server's responsibility. Applications must opt into a crop-capable endpoint and
worker; this client method alone does not enable editing or publication.
