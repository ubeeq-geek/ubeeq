# Provider page label parsing

`parseDeviantArtPublicAiLabels` extracts optional booleans from the recognized plain or quote-escaped page-state object beginning with the exact numeric deviation ID in an HTTPS provider URL. It parses a complete object within the existing 5,000-character record limit; neighboring objects and nested flags cannot supply missing labels. Conflicting matching objects, malformed objects and unrecognized shapes return unknown labels (`{}`).

This is a compatibility reader, not a general HTML/JavaScript parser or a verified provider API guarantee. Other field ordering and complex escaping may remain unrecognized. Page fetching, response-size limits, provider changes, provenance and eligibility remain caller concerns. Unknown labels are not negative labels or permission to publish. Tests use synthetic page-state fixtures; no live provider requests are made.
