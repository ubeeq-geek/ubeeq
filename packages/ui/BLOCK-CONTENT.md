# Browser description blocks

React consumers can import `BlockEditor` and its props from `@ubeeq/ui/react`.
React is an optional peer dependency and is not loaded by the base UI entry point.
Work-body consumers can enable `allowStructured` to insert sections, links and
credits. Keep it disabled for description-only serialization, which drops these
types. Link and credit inputs edit metadata without navigating or fetching URLs;
public renderers must enforce their own URL policy.
Consumers provide styles for the `portable-block-editor-*` classes; CSS scanners
must include the shared entry point when retaining product component styles.
The component preserves the existing description/media editor interaction model.
Sections recursively use the same editor. Other unsupported block types are
preserved with a visible notice rather than receiving dedicated controls. Current rendering
tests cover controls and read-only output, not selection, paste, formatting or
browser DOM sanitization.

The block-content helpers preserve the legacy description-editor contract and
stored `blockId` / `mediaId` / `payload` / `blocks` field names. Portable canonical
block conversion remains in core. Consumers select destination heading limits
with `serializeDescriptionBlocks(blocks, { maxHeadingLevel: 3 })`; provider names
and delivery policy do not belong in the shared helper.

Description normalization intentionally keeps only paragraphs, headings, quotes
and dividers. Do not run it on an entire Work body containing media or sections.
`clonePostBlocks` instead preserves the full structured tree and deeply copies
metadata, preventing mutations from leaking into the source record.

`changeTextBlockType` changes only text presentation fields while preserving
identity and extension metadata; it rejects conversion of non-text blocks.
`movePostBlock` reorders complete top-level subtrees with isolated copies. These
operations act within one editor level; nested section editors invoke the same
operations on their own block arrays.

Rich-text parsing uses the browser DOM to retain supported inline formatting and
links. In a non-DOM runtime, input is escaped conservatively; this fallback is
not equivalent to browser rendering. Current Node tests cover fallback behavior,
text import, heading limits and clone isolation, not DOM sanitizer qualification.
Visual and interactive browser verification remains necessary.
