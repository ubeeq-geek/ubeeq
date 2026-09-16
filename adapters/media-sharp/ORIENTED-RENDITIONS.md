# Explicit oriented-coordinate renditions

`renderImageRendition`, `SharpImageRenditionProcessor` and
`renderCoverRenditions` accept `coordinateSpace: 'raw' | 'oriented'`.
Omitting it preserves raw pre-EXIF behavior and metadata shape, including byte
compatibility for existing recipes. Unknown values fail closed.

Oriented mode applies EXIF rotation/mirroring **before** extraction and resizing.
Crops, focal points, crop bounds and returned dimensions all describe that
upright raster. Rendition sets also report `coordinateSpace: 'oriented'`,
`rawSourceWidth`, `rawSourceHeight` and `sourceOrientation`; immutable source
bytes/version lineage are unchanged. JPEG outputs have no orientation tag.
This follows Sharp's [autoOrient operation](https://sharp.pixelplumbing.com/api-operation/#autoorient).

Consumers must persist the coordinate-space choice with saved crop records and
reuse it on regeneration. Do not reinterpret historical raw crops as oriented
coordinates, or pass raw coordinates produced by `cropRectToSource` into oriented
mode. New browser-upright selections can use oriented mode directly; applications
remain responsible for matching the image decoder/preview and selected file.

The existing source, decoded-pixel and output budgets remain enforced by the
bounded set renderers. The lower-level single rendition renderer retains its
existing pixel-limit contract; callers must bound source/output bytes themselves.
No storage, delivery, publication, job schema or product defaults change here.

Native tests compare all eight EXIF orientations with independently mapped pixel
fixtures, including off-centre mirrored crops, fitted output, square selection,
cover focal points/overrides, metadata, raw byte compatibility, option mutation
and budget failures. Browser QA and consumer adoption are separate gates.
