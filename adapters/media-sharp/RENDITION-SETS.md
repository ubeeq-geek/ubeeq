# Image rendition sets

`SharpImageRenditionProcessor` implements the shared media processor port with
four fitted JPEG sizes (320, 640, 1280, 1920) and three square JPEG crops
(256, 512, 1024). Fitted outputs never enlarge; square crops may enlarge.
Quality is 82. Crops use decoded source pixels before EXIF orientation, as in
`renderImageRendition`; this is not an auto-oriented or animated-image pipeline.

The first output retains the existing `preview:ASSET:VERSION` identity. Other
outputs use their recipe names and the same source lineage. All are private
preview candidates; none authorizes public delivery or replaces the original.
The worker persists the complete result through its existing lease/commit fence.
Measured processing units count the seven generated outputs, not elapsed CPU time.

Defaults bound source bytes to 50 MiB, decoded input to 40 million pixels, and
aggregate output bytes to 50 MiB. Generation is sequential; the byte budget is
checked after each encoded result, not a native decoder memory/CPU deadline.
Products may supply tighter budgets and a square crop. Existing assets are not
automatically regenerated, and rendition selection remains caller-owned.
