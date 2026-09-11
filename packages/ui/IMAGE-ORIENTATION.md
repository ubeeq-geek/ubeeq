# Orientation-aware crop coordinates

orientedImageSize, cropRectToOriented, cropRectToSource and
orientedFocalPointToSource bridge upright previews and raw-source crop controls.
All eight EXIF orientations include reflections. Rectangle coordinates describe
integer pixel edges; selections must stay inside the corresponding image bounds.
Missing orientation defaults to 1; invalid orientation values reject.

Inputs and returned objects are independent. No source decoding, file transfer,
rendering, storage or access-policy changes are performed. Existing renderers
continue using raw-source pixels; these helpers do not silently rotate outputs.
Applications still need trusted source dimensions/orientation and a matching
preview before wiring visual selection. Full visual-editor integration is pending.

Node/browser tests cover reference rectangles, boundary pixels, inverse mappings
and focal fractions. Run npm run test:crop-orientation at the repository root for
an additional comparison against Sharp's native auto-orientation for every pixel
of an asymmetric fixture under all eight tags. Native dependencies remain in
the media adapter, not the UI runtime.

Reference behavior: https://sharp.pixelplumbing.com/api-input/ and
https://sharp.pixelplumbing.com/api-operation/#autoorient .
