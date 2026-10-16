# YouTube resumable transport

`YouTubeUploadClient` implements resumable initiation, offset queries, bounded
chunks and processing reads. `transferYouTubeUpload` queries Google's accepted
offset before reading source bytes and reports each accepted checkpoint. A host
can bound chunks per worker invocation and persist continuations in its queue.

The host must authorize the original and destination, obtain actual OAuth grants,
collect privacy/audience/notification declarations, and serialize each publication.
Persist an initiating marker before the first POST. A lost initiation response or
expired session requires reconciliation; it must not initiate another upload
automatically. Encrypt session URLs and omit them from public responses, exports
and logs. Bind source size/hash/version to the attempt and recheck admission before
each read and final publication commit. Transport retries never infer a new grant.

Tests use synthetic bytes and mock Google responses. Live Google project approval,
quota and channel permissions remain deployment qualifications.
