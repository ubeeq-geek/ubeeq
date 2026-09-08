# Bounded provider response text

`readBoundedResponseText(response, maxBytes)` counts streamed bytes before decoding, rejects oversized content-length hints and independently enforces the budget when hints are absent or inaccurate. Split UTF-8 sequences are preserved. Over-budget or failed reads reject without returning partial text and cancel/release the reader.

Callers still own fetch deadlines, URL/redirect admission, status handling and an appropriate budget. This bounds consumed payload, not transport-internal buffering, source chunk allocation, wall-clock duration or the final string's exact heap footprint. A null body returns empty text. The reader does not fetch, retry, log provider data or schedule jobs.
