# Shared load-more control

The React entry point exports AutoLoadSentinel. The caller supplies enabled and
loading state, a load callback, and optional labels, class name, and observer
margin (default 240px 0px). An intersecting sentinel invokes the callback; the
effect disconnects its observer when replaced or unmounted. Disabled pagination
renders nothing; loading disables the button and automatic observation.

Without IntersectionObserver the manual button remains usable. Its explicit
button type avoids submitting an enclosing form. The caller still owns request
deduplication, errors, pagination cursors and state; this is not a fetch queue.
Tests cover rendered semantics and an injected observer/hook lifecycle, not
interactive browser or screen-reader qualification.
