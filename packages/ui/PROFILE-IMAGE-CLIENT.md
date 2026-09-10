# Profile image client

CreatorClient supports profile-image summaries, raw Blob uploads with a
revision and optional crop/alt text, private square512 previews, and removal.
The API owns admission, crop validation, output sizes and persistence. Upload
query fields and credentials are captured before awaiting transport; Blobs are
immutable. Credentials remain in memory. No automatic retry is performed.

After an ambiguous write response, applications must read the current revision
and reconcile the saved image before another write. A new revision is not an
idempotency key. Tests exercise both compiled Node and browser client targets.
