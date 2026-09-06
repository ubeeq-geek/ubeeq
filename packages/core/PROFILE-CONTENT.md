# Profile content boundaries

`CreatorProfileService` edits plain-text profile fields through an authorized,
revision-conditional persistence port. Products retain handle reservations,
visibility, themes and publishing policy. A port must not emulate a conditional
commit with an unguarded read followed by a write.

`sanitizeLimitedRichText` preserves the legacy profile format: bold, emphasis,
underline and line breaks, with a product-selected text limit. It emits only
that limited formatting and escaped text; it is not a general HTML sanitizer,
does not balance malformed formatting tags, and should not process a whole page.
`limitedRichTextToPlainText` is for text sinks, not for insertion as HTML.

`normalizeProfileExternalLinks` implements the compatibility parsing path:
inspect the first 12 input entries by default, omit invalid entries, canonicalize
known labels and require their configured exact domain or subdomain. Products
supply their own platform catalogue and decide whether custom labels are allowed.
Only HTTP(S) URLs without embedded credentials are retained. These are display
links, not permission to fetch remote resources; no SSRF protection is implied.

The plain-text profile service rejects invalid submissions, while the legacy
normalizer drops invalid entries. Callers must deliberately select the appropriate
contract rather than silently exchanging one for the other.
