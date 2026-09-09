# Portable description import

`parseDescriptionBlocks` uses the same inert HTML parser in Node and the browser.
HTML no longer becomes literal escaped markup merely because DOMParser is absent.
Top-level headings, quotes, dividers and paragraph containers become description
blocks; intervening inline nodes are grouped into paragraphs. Inline content uses
the existing allowlist sanitizer. Plain text paragraph handling is unchanged.

Inputs are limited to 1 MiB of JavaScript string length. Parsed HTML is limited to
50,000 visited nodes and depth 256 before recursive serialization. Unsupported
active/foreign markup does not become executable content. Block IDs are generated
per import, not derived from source content; callers must persist the result to
preserve identity across reloads.

This supplies a portable conversion mechanism, not an automatic migration of
existing Works. Product applications must explicitly decide when to convert legacy
descriptions, preserve existing bodies and revisions, and test their import path.
The description model intentionally flattens lists and container structure as
before; it is not a lossless arbitrary-HTML or complete document importer.
