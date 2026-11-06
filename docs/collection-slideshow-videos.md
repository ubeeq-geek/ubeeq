# Optional collection slideshow videos

The reference workspace exposes **Collections** at `/collections`. Create a
collection, add image Works, arrange their order and save it. Check **Generate
slideshow video** to reveal the export controls. Collection creation and editing
do not enqueue renders.

Defaults are four seconds per image, a half-second crossfade, landscape
1920 × 1080 and no music. Timing and transition length are adjustable. A cut has
no overlap; crossfades overlap adjacent images, so total duration is
`images × slide duration − (images − 1) × transition duration`. Portrait
1080 × 1920 and square 1080 × 1080 are also available. Images retain their
proportions with black borders. Output is 30 fps, H.264/yuv420p MP4 with fast-start
metadata and optional AAC stereo audio.

Upload music to a separate Work through the reference workspace. Add up to ten
tracks in playback order, optionally trim each track, choose whether the playlist
loops, and adjust its final fade-out. Without looping, short music is followed by
silence. The Creator must confirm permission to use the selected music on the
intended platforms. No music catalogue or automatic rights clearance is supplied.

The reference export accepts JPEG, PNG and WebP images. Every Work in the selected
collection must contain only supported, ready images; images within a Work use
upload order (creation timestamp, then asset ID). Mixed-media or empty Works are
rejected instead of silently omitted. Limits are 100 images, one hour of video,
256 MiB of combined source bytes, 40 million pixels per image, and 512 MiB output.
Timings use 1/30-second precision; the UI exposes 0.1-second increments.

## Enable a renderer

Native rendering is disabled until the host configures both executables for the
API **and worker**, using an installed FFmpeg build with `libx264`, AAC, `xfade`
and the relevant image/audio decoders:

```sh
export UBEEQ_FFMPEG_PATH=/usr/bin/ffmpeg
export UBEEQ_FFPROBE_PATH=/usr/bin/ffprobe
npm run dev:api
# In another terminal with the same environment:
npm run start:worker --workspace @ubeeq/reference-api
```

Start `npm run dev:web` and open `/collections`. The worker processes queued
videos in the background; the UI polls status and provides **Download MP4** when
complete. Reloading the page retains queued and completed renders.

Applications can instead supply `ReferenceApiConfiguration.slideshowRenderer`.
Reusable contracts are `SlideshowSettings`, `normalizeSlideshowSettings`,
`slideshowDurationSeconds` and `slideshowDimensions` in `@ubeeq/core`,
`SlideshowRenderer` in `@ubeeq/processing`, `FfmpegSlideshowRenderer` in
`@ubeeq/media-ffmpeg`, and `CollectionSlideshowClient` plus
`CollectionSlideshowPanel` in `@ubeeq/ui` and `@ubeeq/ui/react`. Compatibility
library consumers must compose their own transport, snapshots, persistence and
admission; the reference routes use canonical repository records.

## Jobs, lineage and access

The reference composition stores a separate private Asset rendition without a
Work attachment. Its snapshot binds collection revision, ordered image and music
asset versions/checksums, Work revisions and normalized settings. Neither browser
playback nor a render changes the collection’s original assets or publications.
Source bytes and output bytes never enter job JSON.

Durable `collection.slideshow` jobs retry transient failures. The pending Asset
also acts as an outbox, allowing workers to repair a crash before enqueue. Request
IDs are idempotent for an exact snapshot; changing sources or settings requires a
new request ID. Failed/stale renders can be regenerated using their prior settings.
Source changes before or during rendering prevent completion. Later changes mark
the rendition stale and disable downloading until a new render is generated.
Metadata-only manifest imports retain lineage but remove dispatch flags and job
references. They never restart slideshow rendering or grant access to old output.

Generation and download require the collection owner, current cell/data home,
active ready source assets, and clear admission for the Creator, collection,
Works and assets. Downloads recheck current lineage and holds, verify stored
bytes, and use authenticated requests with `private, no-store`; no public URL is
issued. Previously downloaded bytes cannot be revoked. Serving these MP4 files
through a provider still requires a separately supported video-upload connector.

The FFmpeg adapter has a five-minute total render deadline, cleans its private
temporary files on success/failure, checks input metadata and output codecs,
dimensions, duration and byte limits, and strips input metadata. Commands use
argument arrays, generated local filenames, file-only protocols and one encoding
thread. Deployments must isolate native decoders and supply memory, CPU and disk
limits. This reference implementation scans paginated repositories and rechecks
state around side effects; it is not a transactionally consistent, indexed
production catalogue or a general media moderation service.

## Reference API

- `GET /v1/collections`: owner collections/order, active Works, music and availability.
- `PUT /v1/collections/:id/works`: ordered `workIds` and `expectedRevision`.
- `POST /v1/collections/:id/slideshows`: `requestId`, optional `settings`, and
  `musicRightsConfirmed: true` when music is selected; returns HTTP 202.
- `GET /v1/collections/:id/slideshows`: durable rendition status/history.
- `GET /v1/collections/:id/slideshows/:renditionId`: one rendition’s state and staleness.
- `GET /v1/collections/:id/slideshows/:renditionId/content`: private MP4 attachment.

All routes require a bearer session. The UI never passes credentials in URLs.

Native verification can be run with installed tools:

```sh
TEST_FFMPEG_PATH=/usr/bin/ffmpeg TEST_FFPROBE_PATH=/usr/bin/ffprobe \
  npm test --workspace @ubeeq/media-ffmpeg
npm run test:slideshow-browser # Also requires Chromium; CHROMIUM_PATH overrides its path.
```
