# Upright editing source preview

createCropSourcePreview snapshots source bytes and budgets before awaiting decode,
then reuses createImagePreview for an upright, metadata-stripped JPEG. The result
includes original source dimensions and EXIF orientation plus preview dimensions.
It performs no storage, authentication, publication or delivery operations.

Defaults: 50 MiB source bytes, 40 million source pixels, 640-pixel preview edge,
2 MiB output bytes. Applications can set tighter budgets; preview edge cannot
exceed 4096. Native buffers/decoder allocations can coexist within this operation;
it is not constant-memory streaming or a hard decoder time limit. Existing
rendition defaults and source-pixel crop contracts are unchanged.

The shared client brandingCropSource decodes the private API's bounded preview
envelope to a Blob, checking geometry, orientation, MIME, byte budget and length.
Applications must authorize access and compare revision/image ID with their
current editor state before creating a preview URL. No automatic writes occur.

Tests check native orientation output, source/options mutation, byte/pixel
budgets and both client targets. Full editor visual/accessibility QA is separate.
