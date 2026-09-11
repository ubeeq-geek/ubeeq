# Bounded Node stream-to-file sink

`writeBoundedStreamFile(body, absolutePath, limits)` streams a nonempty Node
Readable into a new mode-0600 file, returning byteLength and checksumSha256.
The source is destroyed on every success/failure path. Existing destinations are
never overwritten. Caller limits are captured before asynchronous work.

`maximumBytes` is required; optional contentLength is an untrusted size hint and
optional expectedLength is the caller's admitted exact size. Supplied lengths
must agree and fit the maximum. Actual bytes must match both. Excess chunks are
rejected before forwarding to disk. No full-source buffer is accumulated.

The caller owns source authorization/version selection, private parent-directory
isolation, partial-file cleanup, available disk space and execution deadlines.
This helper does not fetch objects, enforce a product allowance, remove files,
follow provider redirects or publish anything. It is a Node runtime API.
