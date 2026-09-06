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
width at most 1920, proportional even height, quality 3.

Run native decoders in a restricted worker with only the current attempt's files
available. A file-only protocol whitelist does not isolate filesystem access or bound
decoder memory/CPU. The host must supply those limits and a total job deadline/lease
strategy. A failed attempt can leave partial output files; callers own cleanup and
must not publish incomplete results. This is sampling, not moderation approval or
playback transcoding. Container/codec/duration admission belongs to supplied profiles.
