# Private audio rendition processor

`FfmpegAudioProcessor(tools, profile, { maxSourceBytes, maxOutputBytes })`
implements MediaProcessor with product-owned policy and budgets. Nothing installs
it implicitly. FfmpegVideoToolAdapter provides probe and encodeAudio using
explicit local binaries.

Policy, budgets, source bytes and lineage are snapshotted. Temporary source files
use mode 0600 in a private directory. The admitted audio stream is explicitly
mapped to a 128-kbit/s, 44.1-kHz stereo MP3. Source tags, chapters, artwork and
non-audio streams are not copied. Returned role is preview and MIME is audio/mpeg:
consumers must render audio controls, not images. The original is unchanged.

Encoding stops at the admitted source duration, not an arbitrary excerpt length.
It trusts probe metadata, which cannot prove there are no later decodable samples
or source corruption. Output is size-checked before reading, signature-checked,
reprobed, and required to match source duration within 150 ms for encoder padding.
It must be MP3, stereo and 44.1 kHz. Failures return no partial result and all
attempt files are cleaned in finally.

Commands are shell-free, file-protocol-only and individually time-limited, with
bounded command output and SIGKILL on timeout. FFmpeg can slightly overshoot its
file-size guard; final byte checks reject oversized output. See
[FFmpeg duration and file-size options](https://ffmpeg.org/ffmpeg.html).
This is not an OS sandbox, total job deadline, disk quota or memory quota.
Deployments still need decoder isolation and aggregate resource controls.

The processor performs no authorization, storage, enqueue or publication. The
durable worker must verify original integrity/version, persist outputs privately
and fence commits. Product composition, audio job admission and player wiring
remain unfinished. No public routes, product defaults or deployments changed.
