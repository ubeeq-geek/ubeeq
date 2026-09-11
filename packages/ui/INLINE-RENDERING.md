# Portable inline rendering

`sanitizeInlineHtml` and `inlineHtmlToText` use parse5's inert HTML-fragment parser
in both browser bundles and Node. Version 7 is used for its dual CommonJS/ESM
exports, matching this package's existing build profiles.

The sanitizer reconstructs a small inline allowlist: strong/emphasis, underline,
strike, code, line breaks and protocol-checked links. It never serializes source
elements or copies arbitrary attributes. Script/style/template/iframe/object
content and foreign namespaces are dropped. Unsupported ordinary HTML elements
are unwrapped. Links include `noopener noreferrer`.

This intentionally changes the former Node fallback: supported inline markup now
renders as formatting instead of escaped tag text, and text extraction decodes
entities consistently. The description importer still has separate DOM/non-DOM
behavior; this change does not claim complete server-side rich-description import.

Each call rejects more than 1 MiB of input code units or 50,000 visited nodes. The
output walk is iterative; these limits are not a CPU deadline for parsing hostile
input. Consumers must retain request and block-tree limits. No stored content is
rewritten, and this sanitizer does not authorize links or media publication.

Tests cover normalized formatting, server rendering, malformed nesting, encoded
unsafe schemes, active/foreign elements, idempotence and input/node budgets.
