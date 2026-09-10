# Bounded cover rendition sets

`renderCoverRenditions(source, options)` renders a caller-supplied set of 1–16
uniquely named variants. Each supplies width, height and an optional source-pixel
crop. Without an override, shared focal-point crop math applies. Coordinates
precede EXIF orientation. The caller owns product sizes, names and storage.

Source bytes and nested options are snapshotted before decoder awaits. All crop
selections are resolved before rendering starts. The function returns source
dimensions, the clamped focal point and ordered JPEG bytes with their crops;
it performs no writes, publication, moderation or authorization.

Defaults are 50 MiB source bytes, 40 million source pixels, 40 million aggregate
requested output pixels and 50 MiB aggregate output bytes. Each can be configured
as a positive safe integer; there is no unbounded opt-out. Invalid selections or
budgets reject without a returned partial set. Callers should validate/render
before beginning storage writes. Reads preceding this helper, storage write
atomicity, job leases and cleanup remain responsibilities of the composition.
