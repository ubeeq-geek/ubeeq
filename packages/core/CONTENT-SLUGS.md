# Content slug compatibility

`normalizeContentSlug` supplies the shared ASCII URL-label mechanism. The caller
chooses a fallback and an optional output length limit. Input validation and any
pre-normalization length limit remain explicit at the consuming boundary.

Normalization lowercases, trims, replaces non-ASCII-alphanumeric runs with hyphens,
removes edge hyphens, then applies the optional output limit. This deliberately
preserves legacy truncation behavior, including a possible final hyphen. It is not
Unicode transliteration and must not be applied silently to persisted identifiers.

`normalizeSlugHistory` retains distinct normalized aliases in first-seen order,
without mutating its input. `matchesContentSlug` compares a canonical current slug
and normalized historical aliases using the caller's normalization policy.

These helpers neither reserve identifiers nor prove availability. A service's
read-before-write check is insufficient under concurrency: persistence must enforce
scope and atomically reserve current and historical aliases with the record write.
Products retain restricted terms, identity-name rules and suggestion catalogues.
