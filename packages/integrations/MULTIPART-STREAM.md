# Streamed multipart encoding

createMultipartStream serializes ordered text fields followed by one streamed file. It generates an unpredictable boundary by default, validates header-bearing names/content type, and replaces filename quotes/line breaks. File bytes are read only during body consumption. Source failures propagate; normal completion, generator exit and explicit dispose close destroyable sources. Call dispose when a request is abandoned before consumption.

This Node stream encoder does not initiate requests, authorize publication, impose source-byte quotas or deadlines, retry writes, or persist data. Text metadata is buffered; callers must bound metadata and file size. Injected fixed boundaries are for controlled composition/tests and must not collide with content. The caller must classify a partially sent request as potentially ambiguous. Fixtures use synthetic bytes only.
