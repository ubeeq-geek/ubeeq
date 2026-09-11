# Optional FFmpeg video tools

`FfmpegPosterProcessor` composes these tools with a supplied validation profile to
produce one private JPEG poster at time zero. It preserves source-version lineage,
bounds output bytes, and removes its temporary attempt files on success or failure.
The calling worker remains responsible for source byte limits, integrity checks,
authorization, durable storage, and atomic job/result completion.

Implements the processing package's VideoToolAdapter using explicitly configured
FFmpeg/FFprobe executables. No binaries, cloud SDKs, product profiles or environment
defaults are included. Commands use argument arrays, absolute local paths, a file-only
protocol whitelist, bounded captured output, and a per-command timeout (30 seconds
by default). Frame encoding retains the compatibility JPEG recipe: metadata stripped,
width at most 1920 by default (configurable through `maxFrameWidth`), proportional
even height, quality 3.

`renderVideoPoster` supports already-admitted byte sources and a caller-selected
capture timestamp without requiring a metadata probe. It bounds JPEG output reads
and cleans private temporary input/output files on success and failure. Input
download limits, decoder isolation, source-version binding and publication remain
the caller's responsibility; the helper is not a video validation profile.

Run native decoders in a restricted worker with only the current attempt's files
available. A file-only protocol whitelist does not isolate filesystem access or bound
decoder memory/CPU. The host must supply those limits and a total job deadline/lease
strategy. A failed attempt can leave partial output files; callers own cleanup and
must not publish incomplete results. This is sampling, not moderation approval or
playback transcoding. Container/codec/duration admission belongs to supplied profiles.
# Sampled frames

The opt-in `FfmpegFrameProcessor` provides source-version-bound sampled JPEG
previews with explicit source, per-frame, aggregate-byte and frame-count budgets.
See `FRAMES.md` in the source repository for the contract and remaining caller
responsibilities. It does not change the default poster processor.
