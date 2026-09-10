# Profile image client

CreatorClient supports profile-image summaries, raw Blob uploads with a
revision and optional crop/alt text, private square512 previews, and removal.
The API owns admission, crop validation, output sizes and persistence. Upload
query fields and credentials are captured before awaiting transport; Blobs are
immutable. Credentials remain in memory. No automatic retry is performed.

recropProfileImage submits an explicit crop and expected revision without image
bytes or a storage key. The server must resolve the currently retained original
and enforce ownership and revision checks. Omitted alt text preserves the saved
description. This is an explicit write, not an automatic preview operation.

After an ambiguous write response, applications must read the current revision
and reconcile the saved image before another write. A new revision is not an
idempotency key. Tests exercise both compiled Node and browser client targets.
# Explicit upload coordinates

`saveProfileImage(id, revision, file, crop, altText, coordinateSpace?)` accepts
an optional final `'raw' | 'oriented'` argument. Omission preserves the existing
request. Invalid values fail before transport; the mode is serialized before
awaiting. Servers must store the mode with saved crops and use that stored mode
on re-crop; `recropProfileImage` does not choose or change coordinate space.
