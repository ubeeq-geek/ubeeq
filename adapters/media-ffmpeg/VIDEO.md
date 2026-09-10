# Private MP4 rendition processor

FfmpegVideoProcessor requires explicit video/audio admission profiles, source and
output byte budgets, and output dimensions. It accepts one moving video stream
and at most one allowed audio stream. Additional stream types are rejected.
Image crop requests are not accepted. Inputs and policy are captured before I/O.

The native adapter renders H.264/yuv420p at 30 fps with optional stereo 48-kHz AAC,
bounded dimensions, one encoder thread and fast-start MP4. It strips source
metadata/chapters and does not overwrite output files. FFmpeg and FFprobe paths
and per-command timeout are supplied explicitly; binaries are never downloaded.

The processor checks output byte size, MP4 header, probed codec/dimensions/audio
shape and duration (within 250 ms of the admitted source), then returns one
version-bound video preview. Temporary files are cleaned after success or failure.
This is not a publication decision, durable job, storage write or product default.

Limits are not a hard decoder sandbox or filesystem quota. FFmpeg may exceed its
requested file size before stopping; the result is rejected if over budget.
Processing buffers the admitted source and completed output. Container metadata
validation is not proof that every source packet is safe or decodable. Products
still need worker isolation, total deadlines, source fencing and their own
admission and delivery composition before enabling this processor.
