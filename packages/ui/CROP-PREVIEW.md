# Shared crop preview UI

The root UI export provides squareCropFromControls, coverCropFromControls and
cropPreviewPoint. Focal controls use percentages; square zoom is at least one.
Coordinates are original-image pixels with rounded placement. Extremely narrow
cover crops retain at least one pixel, matching the shared backend crop bounds.

The optional React export provides CropCanvas: crop drawing, pointer selection,
application-supplied CSS class and accessible label. It clears stale drawings
when image/crop is removed and ignores zero-size canvas bounds and non-primary
pointer buttons. Applications supply keyboard-operable controls alongside it.

Product branding kinds, output sizes, file selection, object URL lifetime,
labels, admission and upload/save actions remain with the application. Geometry
and server-rendered markup tests are not browser visual/accessibility QA.
