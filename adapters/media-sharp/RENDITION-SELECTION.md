# Selecting image renditions

`SharpImageRenditionProcessor` accepts optional constructor `renditionNames`, a
nonempty unique subset of `w320`, `w640`, `w1280`, `w1920`, `square256`,
`square512`, and `square1024`. Omitting it retains all seven outputs.

Selection is snapshotted at construction. Only selected recipes are rendered;
results retain canonical order regardless of requested order. The `w320` output
still uses the existing `preview:` identifier. Recipes, source lineage, crop
metadata and JPEG bytes are unchanged. Measured units count returned outputs.
Source byte and pixel budgets still apply; the output budget counts selected
outputs. Empty, unknown and duplicate selections reject at construction.

For example, a square-only composition can request the three square recipes
without paying to render four unused fitted previews. Storage destinations,
publication authority and product-specific selection remain with the caller.
Do not configure an existing worker to omit previews its consumers require.
