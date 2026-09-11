# Image source validation

`validateImageSource(bytes, mimeType, options?)` decodes a transient one-pixel
preview and checks the decoded format against the declared JPEG, PNG, WebP, GIF
or TIFF MIME type (case-insensitive). It returns a safe boolean and either the
decoded format or a stable rejection reason; decoder diagnostics are not exposed.
Default limits are 50 MiB of input and 40 million input pixels. Optional positive
integer budgets permit deployment-specific limits; invalid budgets throw.

The function performs no storage, publication, credential access or product
admission. `safe: true` means only that these image decode/type checks passed,
not malware clearance, content moderation, ownership or rights approval. It uses
the preview decoder's default page/frame, not every page or animation frame.
The budgets are not a wall-clock deadline or a complete process memory bound.
