# Crop-based image renditions

`@ubeeq/processing` exports `pickSquareCrop` and `pickCoverCrop` for centered,
requested-rectangle and focal-point geometry. Coordinates are clamped to the source
pixel rectangle. Non-finite inputs are rejected; extreme aspect ratios retain at
least one pixel instead of rounding a crop dimension to zero.

`renderImageRendition` applies an optional rectangle, resizes and emits JPEG bytes.
It does not rotate EXIF-oriented images: its coordinates refer to unrotated decoded
pixels. This preserves legacy editor coordinates and differs intentionally from the
existing auto-rotating preview helper. JPEG quality defaults to 82 with mozjpeg.

The default input budget is 40 million pixels. `maxInputPixels: false` exists only
as an explicit legacy compatibility opt-out. Callers must bound source byte sizes,
output dimensions, number of renditions and processing concurrency. Recipes are not
safe to accept directly from untrusted client input without validation/admission.

Products own rendition names, sizes, enlargement policy, storage keys, caching and
authorization. The renderer neither reads storage nor publishes output. Output-set
atomicity, source versioning and retry cleanup belong to the consuming worker or
storage composition; extracting this renderer does not establish those guarantees.
